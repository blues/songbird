/**
 * Tests for the Ingest API Lambda
 *
 * Tests event processing for all Notehub event types:
 * track.qo, _track.qo, _log.qo, _health.qo, _geolocate.qo,
 * alert.qo, command_ack.qo, _session.qo
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, PutCommand, UpdateCommand, QueryCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import type { APIGatewayProxyEvent } from 'aws-lambda';

// Mock the device-lookup module before importing handler
vi.mock('../shared/device-lookup', () => ({
  handleDeviceAlias: vi.fn().mockResolvedValue({ isNewDevice: false, isSwap: false }),
}));

import { handler } from './index';
import { handleDeviceAlias } from '../shared/device-lookup';

const ddbMock = mockClient(DynamoDBDocumentClient);
const snsMock = mockClient(SNSClient);

beforeEach(() => {
  ddbMock.reset();
  snsMock.reset();
  vi.mocked(handleDeviceAlias).mockResolvedValue({ isNewDevice: false, isSwap: false });
  // Default: no existing device state, no unacknowledged alerts
  ddbMock.on(GetCommand).resolves({ Item: undefined });
  ddbMock.on(QueryCommand).resolves({ Items: [] });
  ddbMock.on(PutCommand).resolves({});
  ddbMock.on(UpdateCommand).resolves({});
  snsMock.on(PublishCommand).resolves({});
});

function makeEvent(body: any): APIGatewayProxyEvent {
  return {
    body: JSON.stringify(body),
    headers: {},
    multiValueHeaders: {},
    httpMethod: 'POST',
    isBase64Encoded: false,
    path: '/ingest',
    pathParameters: null,
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    requestContext: {} as any,
    resource: '',
  };
}

function makeNotehubEvent(overrides: Record<string, any> = {}) {
  return {
    event: 'dev:1234#track.qo#1',
    session: 'session-1',
    best_id: 'dev:1234',
    device: 'dev:1234',
    sn: 'songbird01-bds',
    product: 'product:test',
    app: 'app:test',
    received: 1700000000,
    req: 'note.add',
    when: 1700000000,
    file: 'track.qo',
    body: {
      temp: 22.5,
      humidity: 45,
      pressure: 1013.25,
      mode: 'demo',
    },
    best_lat: 37.7749,
    best_lon: -122.4194,
    best_location_when: 1700000000,
    best_location_type: 'gps',
    ...overrides,
  };
}

describe('handler - request validation', () => {
  it('returns 400 when body is missing', async () => {
    const event = makeEvent(null);
    event.body = null;

    const result = await handler(event);
    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error).toBe('Request body required');
  });

  it('returns 400 when serial number is missing', async () => {
    const event = makeEvent(makeNotehubEvent({ sn: '' }));

    const result = await handler(event);
    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error).toContain('Serial number');
  });

  it('returns 400 when serial number is whitespace', async () => {
    const event = makeEvent(makeNotehubEvent({ sn: '   ' }));

    const result = await handler(event);
    expect(result.statusCode).toBe(400);
  });

  it('returns 200 for valid track.qo event', async () => {
    const event = makeEvent(makeNotehubEvent());

    const result = await handler(event);
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body).status).toBe('ok');
  });
});

describe('handler - device alias handling', () => {
  it('calls handleDeviceAlias with serial and device_uid', async () => {
    const event = makeEvent(makeNotehubEvent());

    await handler(event);

    expect(handleDeviceAlias).toHaveBeenCalledWith('songbird01-bds', 'dev:1234');
  });

  it('writes swap event when Notecard swap is detected', async () => {
    vi.mocked(handleDeviceAlias).mockResolvedValue({
      isNewDevice: false,
      isSwap: true,
      oldDeviceUid: 'dev:old',
    });

    const event = makeEvent(makeNotehubEvent());
    await handler(event);

    // Should write a notecard_swap telemetry record
    const putCalls = ddbMock.commandCalls(PutCommand);
    const swapRecord = putCalls.find(
      c => c.args[0].input.Item?.data_type === 'notecard_swap'
    );
    expect(swapRecord).toBeDefined();
    expect(swapRecord!.args[0].input.Item?.old_device_uid).toBe('dev:old');
    expect(swapRecord!.args[0].input.Item?.new_device_uid).toBe('dev:1234');
  });
});

describe('handler - track.qo events', () => {
  it('writes telemetry record with sensor data', async () => {
    const event = makeEvent(makeNotehubEvent());

    await handler(event);

    const putCalls = ddbMock.commandCalls(PutCommand);
    const telemetryRecord = putCalls.find(
      c => c.args[0].input.Item?.data_type === 'telemetry'
    );
    expect(telemetryRecord).toBeDefined();
    const item = telemetryRecord!.args[0].input.Item!;
    expect(item.temperature).toBe(22.5);
    expect(item.humidity).toBe(45);
    expect(item.pressure).toBe(1013.25);
    expect(item.device_uid).toBe('dev:1234');
  });

  it('writes location history when location is present', async () => {
    const event = makeEvent(makeNotehubEvent());

    await handler(event);

    const putCalls = ddbMock.commandCalls(PutCommand);
    const locationRecord = putCalls.find(
      c => c.args[0].input.TableName === process.env.LOCATIONS_TABLE
    );
    expect(locationRecord).toBeDefined();
    expect(locationRecord!.args[0].input.Item?.latitude).toBe(37.7749);
    expect(locationRecord!.args[0].input.Item?.longitude).toBe(-122.4194);
  });

  it('updates device metadata', async () => {
    const event = makeEvent(makeNotehubEvent());

    await handler(event);

    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    expect(updateCalls.length).toBeGreaterThan(0);

    // Find the device metadata update (to DEVICES_TABLE)
    const deviceUpdate = updateCalls.find(
      c => c.args[0].input.TableName === process.env.DEVICES_TABLE
    );
    expect(deviceUpdate).toBeDefined();
  });

  it('checks GPS power save alert when gps_power_saving is true', async () => {
    const notehubEvent = makeNotehubEvent({
      body: { temp: 22, humidity: 45, pressure: 1013, gps_power_saving: true },
    });

    const event = makeEvent(notehubEvent);
    await handler(event);

    // Should check device state for gps_power_saving
    const getCalls = ddbMock.commandCalls(GetCommand);
    const gpsPowerSaveCheck = getCalls.find(
      c => c.args[0].input.ProjectionExpression === 'gps_power_saving'
    );
    expect(gpsPowerSaveCheck).toBeDefined();
  });
});

describe('handler - _track.qo events (GPS tracking)', () => {
  it('writes tracking event with GPS data', async () => {
    const notehubEvent = makeNotehubEvent({
      file: '_track.qo',
      body: {
        velocity: 15.5,
        bearing: 180,
        distance: 500,
        dop: 1.2,
        journey: 1700000000,
        jcount: 5,
      },
      where_when: 1700000100,
    });

    const event = makeEvent(notehubEvent);
    await handler(event);

    const putCalls = ddbMock.commandCalls(PutCommand);
    const trackingRecord = putCalls.find(
      c => c.args[0].input.Item?.data_type === 'tracking'
    );
    expect(trackingRecord).toBeDefined();
    const item = trackingRecord!.args[0].input.Item!;
    expect(item.velocity).toBe(15.5);
    expect(item.bearing).toBe(180);
    expect(item.journey_id).toBe(1700000000);
  });

  it('uses where_when timestamp for _track.qo events', async () => {
    const notehubEvent = makeNotehubEvent({
      file: '_track.qo',
      when: 1700000000,
      where_when: 1700000100,
      body: { journey: 1700000000, jcount: 1, velocity: 10 },
    });

    const event = makeEvent(notehubEvent);
    await handler(event);

    const putCalls = ddbMock.commandCalls(PutCommand);
    const trackingRecord = putCalls.find(
      c => c.args[0].input.Item?.data_type === 'tracking'
    );
    // Timestamp should be where_when * 1000
    expect(trackingRecord!.args[0].input.Item?.timestamp).toBe(1700000100 * 1000);
  });

  it('creates journey on jcount === 1', async () => {
    const notehubEvent = makeNotehubEvent({
      file: '_track.qo',
      body: { journey: 1700000000, jcount: 1, velocity: 10 },
    });

    const event = makeEvent(notehubEvent);
    await handler(event);

    // Should query for previous active journey to mark completed
    const queryCalls = ddbMock.commandCalls(QueryCommand);
    const journeyQuery = queryCalls.find(
      c => c.args[0].input.TableName === process.env.JOURNEYS_TABLE
    );
    expect(journeyQuery).toBeDefined();
  });

  it('detects no-sat status and creates alert', async () => {
    // No existing device state or unacknowledged alerts
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const notehubEvent = makeNotehubEvent({
      file: '_track.qo',
      status: 'no-sat',
      body: { journey: 1700000000, jcount: 1 },
    });

    const event = makeEvent(notehubEvent);
    await handler(event);

    const putCalls = ddbMock.commandCalls(PutCommand);
    const alertRecord = putCalls.find(
      c => c.args[0].input.Item?.type === 'gps_no_sat'
    );
    expect(alertRecord).toBeDefined();
  });
});

describe('handler - _log.qo events (power telemetry)', () => {
  it('writes power telemetry for battery-powered devices', async () => {
    const notehubEvent = makeNotehubEvent({
      file: '_log.qo',
      body: { voltage: 3.8, milliamp_hours: 150 },
    });

    const event = makeEvent(notehubEvent);
    await handler(event);

    const putCalls = ddbMock.commandCalls(PutCommand);
    const powerRecord = putCalls.find(
      c => c.args[0].input.Item?.data_type === 'power'
    );
    expect(powerRecord).toBeDefined();
    expect(powerRecord!.args[0].input.Item?.mojo_voltage).toBe(3.8);
    expect(powerRecord!.args[0].input.Item?.milliamp_hours).toBe(150);
  });

  it('skips power telemetry for USB-powered devices', async () => {
    const notehubEvent = makeNotehubEvent({
      file: '_log.qo',
      body: { voltage_mode: 'usb', voltage: 5.0 },
    });

    const event = makeEvent(notehubEvent);
    await handler(event);

    const putCalls = ddbMock.commandCalls(PutCommand);
    const powerRecord = putCalls.find(
      c => c.args[0].input.Item?.data_type === 'power'
    );
    expect(powerRecord).toBeUndefined();
  });
});

describe('handler - _health.qo events', () => {
  it('writes health event record', async () => {
    const notehubEvent = makeNotehubEvent({
      file: '_health.qo',
      body: { voltage: 3.5, text: 'device started', method: 'normal' },
    });

    const event = makeEvent(notehubEvent);
    await handler(event);

    const putCalls = ddbMock.commandCalls(PutCommand);
    const healthRecord = putCalls.find(
      c => c.args[0].input.Item?.data_type === 'health'
    );
    expect(healthRecord).toBeDefined();
    expect(healthRecord!.args[0].input.Item?.voltage).toBe(3.5);
    expect(healthRecord!.args[0].input.Item?.method).toBe('normal');
  });

  it('creates low battery alert when voltage < 3.0 and restarted', async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const notehubEvent = makeNotehubEvent({
      file: '_health.qo',
      body: { voltage: 2.8, text: 'device restarted due to low power' },
    });

    const event = makeEvent(notehubEvent);
    await handler(event);

    const putCalls = ddbMock.commandCalls(PutCommand);
    const lowBatteryAlert = putCalls.find(
      c => c.args[0].input.Item?.type === 'low_battery'
    );
    expect(lowBatteryAlert).toBeDefined();
    expect(lowBatteryAlert!.args[0].input.Item?.message).toContain('2.80V');

    // Should also publish to SNS
    const snsCalls = snsMock.commandCalls(PublishCommand);
    const lowBatterySnS = snsCalls.find(
      c => c.args[0].input.MessageAttributes?.alert_type?.StringValue === 'low_battery'
    );
    expect(lowBatterySnS).toBeDefined();
  });

  it('does NOT create low battery alert when voltage >= 3.0', async () => {
    const notehubEvent = makeNotehubEvent({
      file: '_health.qo',
      body: { voltage: 3.5, text: 'device restarted' },
    });

    const event = makeEvent(notehubEvent);
    await handler(event);

    const putCalls = ddbMock.commandCalls(PutCommand);
    const lowBatteryAlert = putCalls.find(
      c => c.args[0].input.Item?.type === 'low_battery'
    );
    expect(lowBatteryAlert).toBeUndefined();
  });

  it('does NOT create low battery alert when text does not include restarted', async () => {
    const notehubEvent = makeNotehubEvent({
      file: '_health.qo',
      body: { voltage: 2.5, text: 'normal operation' },
    });

    const event = makeEvent(notehubEvent);
    await handler(event);

    const putCalls = ddbMock.commandCalls(PutCommand);
    const lowBatteryAlert = putCalls.find(
      c => c.args[0].input.Item?.type === 'low_battery'
    );
    expect(lowBatteryAlert).toBeUndefined();
  });

  it('skips duplicate low battery alert when unacknowledged exists', async () => {
    // Return an existing unacknowledged alert
    ddbMock.on(QueryCommand).resolves({
      Items: [{ alert_id: 'existing', type: 'low_battery', acknowledged: 'false' }],
    });

    const notehubEvent = makeNotehubEvent({
      file: '_health.qo',
      body: { voltage: 2.5, text: 'device restarted' },
    });

    const event = makeEvent(notehubEvent);
    await handler(event);

    const putCalls = ddbMock.commandCalls(PutCommand);
    const lowBatteryAlert = putCalls.find(
      c => c.args[0].input.Item?.type === 'low_battery'
    );
    expect(lowBatteryAlert).toBeUndefined();
  });
});

describe('handler - _geolocate.qo events', () => {
  it('writes location event for triangulation results', async () => {
    const notehubEvent = makeNotehubEvent({
      file: '_geolocate.qo',
      body: {},
      tri_lat: 37.77,
      tri_lon: -122.42,
      tri_when: 1700000000,
      best_lat: undefined,
      best_lon: undefined,
    });

    const event = makeEvent(notehubEvent);
    await handler(event);

    const putCalls = ddbMock.commandCalls(PutCommand);
    const locationRecord = putCalls.find(
      c => c.args[0].input.Item?.location_source === 'triangulation' &&
        c.args[0].input.TableName === process.env.TELEMETRY_TABLE
    );
    expect(locationRecord).toBeDefined();
  });
});

describe('handler - alert.qo events', () => {
  it('stores and publishes alert', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const notehubEvent = makeNotehubEvent({
      file: 'alert.qo',
      body: {
        type: 'temp_high',
        value: 35,
        threshold: 30,
        message: 'Temperature exceeded threshold',
      },
    });

    const event = makeEvent(notehubEvent);
    await handler(event);

    // Should store alert
    const putCalls = ddbMock.commandCalls(PutCommand);
    const alertRecord = putCalls.find(
      c => c.args[0].input.Item?.type === 'temp_high'
    );
    expect(alertRecord).toBeDefined();
    expect(alertRecord!.args[0].input.Item?.acknowledged).toBe('false');

    // Should publish to SNS
    const snsCalls = snsMock.commandCalls(PublishCommand);
    expect(snsCalls.length).toBeGreaterThan(0);
  });

  it('skips duplicate alert when unacknowledged exists', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [{ alert_id: 'existing', type: 'temp_high', acknowledged: 'false' }],
    });

    const notehubEvent = makeNotehubEvent({
      file: 'alert.qo',
      body: { type: 'temp_high', value: 35, threshold: 30 },
    });

    const event = makeEvent(notehubEvent);
    await handler(event);

    const putCalls = ddbMock.commandCalls(PutCommand);
    const alertRecord = putCalls.find(
      c => c.args[0].input.Item?.type === 'temp_high'
    );
    expect(alertRecord).toBeUndefined();
  });
});

describe('handler - command_ack.qo events', () => {
  it('updates command status on acknowledgment', async () => {
    const notehubEvent = makeNotehubEvent({
      file: 'command_ack.qo',
      body: {
        cmd_id: 'cmd_abc123',
        status: 'completed',
        message: 'Command executed successfully',
        executed_at: 1700000100,
      },
    });

    const event = makeEvent(notehubEvent);
    await handler(event);

    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    const commandUpdate = updateCalls.find(
      c => c.args[0].input.TableName === process.env.COMMANDS_TABLE
    );
    expect(commandUpdate).toBeDefined();
    expect(commandUpdate!.args[0].input.Key).toEqual({
      device_uid: 'dev:1234',
      command_id: 'cmd_abc123',
    });
  });

  it('skips when cmd_id is missing', async () => {
    const notehubEvent = makeNotehubEvent({
      file: 'command_ack.qo',
      body: { status: 'completed' },
    });

    const event = makeEvent(notehubEvent);
    await handler(event);

    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    const commandUpdate = updateCalls.find(
      c => c.args[0].input.TableName === process.env.COMMANDS_TABLE
    );
    expect(commandUpdate).toBeUndefined();
  });
});

describe('handler - location extraction', () => {
  it('prefers GPS location (best_lat/best_lon)', async () => {
    const notehubEvent = makeNotehubEvent({
      best_lat: 37.77,
      best_lon: -122.42,
      best_location_type: 'gps',
      tri_lat: 37.78,
      tri_lon: -122.43,
      tower_lat: 37.79,
      tower_lon: -122.44,
    });

    const event = makeEvent(notehubEvent);
    await handler(event);

    const putCalls = ddbMock.commandCalls(PutCommand);
    const locationRecord = putCalls.find(
      c => c.args[0].input.TableName === process.env.LOCATIONS_TABLE
    );
    expect(locationRecord!.args[0].input.Item?.latitude).toBe(37.77);
    expect(locationRecord!.args[0].input.Item?.source).toBe('gps');
  });

  it('falls back to triangulation when GPS not available', async () => {
    const notehubEvent = makeNotehubEvent({
      best_lat: undefined,
      best_lon: undefined,
      tri_lat: 37.78,
      tri_lon: -122.43,
      tri_when: 1700000000,
    });

    const event = makeEvent(notehubEvent);
    await handler(event);

    const putCalls = ddbMock.commandCalls(PutCommand);
    const locationRecord = putCalls.find(
      c => c.args[0].input.TableName === process.env.LOCATIONS_TABLE
    );
    expect(locationRecord!.args[0].input.Item?.latitude).toBe(37.78);
    expect(locationRecord!.args[0].input.Item?.source).toBe('triangulation');
  });

  it('falls back to tower when GPS and triangulation not available', async () => {
    const notehubEvent = makeNotehubEvent({
      best_lat: undefined,
      best_lon: undefined,
      tri_lat: undefined,
      tri_lon: undefined,
      tower_lat: 37.79,
      tower_lon: -122.44,
      tower_when: 1700000000,
    });

    const event = makeEvent(notehubEvent);
    await handler(event);

    const putCalls = ddbMock.commandCalls(PutCommand);
    const locationRecord = putCalls.find(
      c => c.args[0].input.TableName === process.env.LOCATIONS_TABLE
    );
    expect(locationRecord!.args[0].input.Item?.latitude).toBe(37.79);
    expect(locationRecord!.args[0].input.Item?.source).toBe('tower');
  });
});

describe('handler - session info extraction', () => {
  it('extracts firmware versions from _session.qo events', async () => {
    const notehubEvent = makeNotehubEvent({
      file: 'track.qo',
      firmware_host: JSON.stringify({ version: '1.2.3' }),
      firmware_notecard: JSON.stringify({ version: '4.5.6' }),
      sku: 'NOTE-WBGLW',
      power_usb: true,
    });

    const event = makeEvent(notehubEvent);
    await handler(event);

    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    const deviceUpdate = updateCalls.find(
      c => c.args[0].input.TableName === process.env.DEVICES_TABLE
    );
    expect(deviceUpdate).toBeDefined();
    const values = deviceUpdate!.args[0].input.ExpressionAttributeValues!;
    expect(values[':fw_version']).toBe('1.2.3');
    expect(values[':nc_version']).toBe('4.5.6');
    expect(values[':nc_sku']).toBe('NOTE-WBGLW');
  });
});

describe('handler - mode change tracking', () => {
  it('records mode change when mode differs from stored', async () => {
    // Device currently in 'demo' mode
    ddbMock.on(GetCommand, {
      TableName: process.env.DEVICES_TABLE,
      ProjectionExpression: 'current_mode',
    }).resolves({ Item: { current_mode: 'demo' } });

    const notehubEvent = makeNotehubEvent({
      body: { temp: 22, humidity: 45, pressure: 1013, mode: 'transit' },
    });

    const event = makeEvent(notehubEvent);
    await handler(event);

    const putCalls = ddbMock.commandCalls(PutCommand);
    const modeChangeRecord = putCalls.find(
      c => c.args[0].input.Item?.data_type === 'mode_change'
    );
    expect(modeChangeRecord).toBeDefined();
    expect(modeChangeRecord!.args[0].input.Item?.previous_mode).toBe('demo');
    expect(modeChangeRecord!.args[0].input.Item?.new_mode).toBe('transit');
  });
});

describe('handler - error handling', () => {
  it('returns 500 on unexpected errors', async () => {
    const event = makeEvent('invalid json{{{');
    event.body = 'invalid json{{{';

    const result = await handler(event);
    expect(result.statusCode).toBe(500);
  });
});
