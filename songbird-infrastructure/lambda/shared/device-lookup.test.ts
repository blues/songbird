/**
 * Tests for device-lookup shared utility
 *
 * Tests serial_number <-> device_uid resolution, alias creation,
 * Notecard swap detection, and historical device_uid tracking.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import {
  getAliasBySerial,
  getAliasByDeviceUid,
  resolveDevice,
  getDeviceUidForSerial,
  getSerialForDeviceUid,
  getAllDeviceUidsForSerial,
  createAlias,
  updateAliasOnSwap,
  handleDeviceAlias,
} from './device-lookup';

const ddbMock = mockClient(DynamoDBDocumentClient);

beforeEach(() => {
  ddbMock.reset();
});

describe('getAliasBySerial', () => {
  it('returns alias when found', async () => {
    const alias = {
      serial_number: 'songbird01-bds',
      device_uid: 'dev:1234',
      created_at: 1000,
      updated_at: 1000,
    };

    ddbMock.on(GetCommand).resolves({ Item: alias });

    const result = await getAliasBySerial('songbird01-bds');
    expect(result).toEqual(alias);
  });

  it('returns null when not found', async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });

    const result = await getAliasBySerial('nonexistent');
    expect(result).toBeFalsy();
  });
});

describe('getAliasByDeviceUid', () => {
  it('returns alias when found via GSI', async () => {
    const alias = {
      serial_number: 'songbird01-bds',
      device_uid: 'dev:1234',
      created_at: 1000,
      updated_at: 1000,
    };

    ddbMock.on(QueryCommand).resolves({ Items: [alias] });

    const result = await getAliasByDeviceUid('dev:1234');
    expect(result).toEqual(alias);
  });

  it('returns null when GSI query returns empty', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const result = await getAliasByDeviceUid('dev:unknown');
    expect(result).toBeNull();
  });

  it('returns null when Items is undefined', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: undefined });

    const result = await getAliasByDeviceUid('dev:unknown');
    expect(result).toBeNull();
  });
});

describe('resolveDevice', () => {
  it('resolves by serial_number first', async () => {
    const alias = {
      serial_number: 'songbird01-bds',
      device_uid: 'dev:1234',
      previous_device_uids: ['dev:old1'],
      created_at: 1000,
      updated_at: 2000,
    };

    ddbMock.on(GetCommand).resolves({ Item: alias });

    const result = await resolveDevice('songbird01-bds');
    expect(result).toEqual({
      serial_number: 'songbird01-bds',
      device_uid: 'dev:1234',
      all_device_uids: ['dev:1234', 'dev:old1'],
    });
  });

  it('falls back to device_uid lookup if serial not found', async () => {
    const alias = {
      serial_number: 'songbird01-bds',
      device_uid: 'dev:1234',
      created_at: 1000,
      updated_at: 1000,
    };

    // First call (GetCommand for serial lookup) returns nothing
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    // Second call (QueryCommand for device_uid GSI) returns alias
    ddbMock.on(QueryCommand).resolves({ Items: [alias] });

    const result = await resolveDevice('dev:1234');
    expect(result).toEqual({
      serial_number: 'songbird01-bds',
      device_uid: 'dev:1234',
      all_device_uids: ['dev:1234'],
    });
  });

  it('returns null when neither lookup finds anything', async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const result = await resolveDevice('nonexistent');
    expect(result).toBeNull();
  });

  it('includes all device_uids when previous exist', async () => {
    const alias = {
      serial_number: 'songbird01-bds',
      device_uid: 'dev:current',
      previous_device_uids: ['dev:old1', 'dev:old2'],
      created_at: 1000,
      updated_at: 3000,
    };

    ddbMock.on(GetCommand).resolves({ Item: alias });

    const result = await resolveDevice('songbird01-bds');
    expect(result!.all_device_uids).toEqual(['dev:current', 'dev:old1', 'dev:old2']);
  });
});

describe('getDeviceUidForSerial', () => {
  it('returns device_uid when alias exists', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { serial_number: 'sb01', device_uid: 'dev:123', created_at: 1, updated_at: 1 },
    });

    const result = await getDeviceUidForSerial('sb01');
    expect(result).toBe('dev:123');
  });

  it('returns null when alias does not exist', async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });

    const result = await getDeviceUidForSerial('nonexistent');
    expect(result).toBeNull();
  });
});

describe('getSerialForDeviceUid', () => {
  it('returns serial_number via GSI lookup', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [{ serial_number: 'sb01', device_uid: 'dev:123', created_at: 1, updated_at: 1 }],
    });

    const result = await getSerialForDeviceUid('dev:123');
    expect(result).toBe('sb01');
  });

  it('returns null when device_uid not found', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const result = await getSerialForDeviceUid('dev:unknown');
    expect(result).toBeNull();
  });
});

describe('getAllDeviceUidsForSerial', () => {
  it('returns current + previous device_uids', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        serial_number: 'sb01',
        device_uid: 'dev:current',
        previous_device_uids: ['dev:old1', 'dev:old2'],
        created_at: 1,
        updated_at: 1,
      },
    });

    const result = await getAllDeviceUidsForSerial('sb01');
    expect(result).toEqual(['dev:current', 'dev:old1', 'dev:old2']);
  });

  it('returns only current when no previous', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { serial_number: 'sb01', device_uid: 'dev:current', created_at: 1, updated_at: 1 },
    });

    const result = await getAllDeviceUidsForSerial('sb01');
    expect(result).toEqual(['dev:current']);
  });

  it('returns empty array when alias not found', async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });

    const result = await getAllDeviceUidsForSerial('nonexistent');
    expect(result).toEqual([]);
  });
});

describe('createAlias', () => {
  it('creates new alias with PutCommand', async () => {
    ddbMock.on(PutCommand).resolves({});

    await createAlias('sb01', 'dev:123');

    const calls = ddbMock.commandCalls(PutCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0].input.Item).toMatchObject({
      serial_number: 'sb01',
      device_uid: 'dev:123',
    });
    expect(calls[0].args[0].input.ConditionExpression).toBe('attribute_not_exists(serial_number)');
  });

  it('handles ConditionalCheckFailedException gracefully', async () => {
    const error = new Error('Conditional check failed');
    error.name = 'ConditionalCheckFailedException';
    ddbMock.on(PutCommand).rejects(error);

    // Should not throw
    await createAlias('sb01', 'dev:123');
  });

  it('rethrows other errors', async () => {
    ddbMock.on(PutCommand).rejects(new Error('Network error'));

    await expect(createAlias('sb01', 'dev:123')).rejects.toThrow('Network error');
  });
});

describe('updateAliasOnSwap', () => {
  it('updates alias with new device_uid and appends old to history', async () => {
    ddbMock.on(UpdateCommand).resolves({});

    await updateAliasOnSwap('sb01', 'dev:new', 'dev:old');

    const calls = ddbMock.commandCalls(UpdateCommand);
    expect(calls).toHaveLength(1);

    const input = calls[0].args[0].input;
    expect(input.Key).toEqual({ serial_number: 'sb01' });
    expect(input.ExpressionAttributeValues![':new_uid']).toBe('dev:new');
    expect(input.ExpressionAttributeValues![':old_uid_list']).toEqual(['dev:old']);
  });
});

describe('handleDeviceAlias', () => {
  it('creates new alias for unknown serial', async () => {
    // getAliasBySerial returns null
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    // createAlias succeeds
    ddbMock.on(PutCommand).resolves({});

    const result = await handleDeviceAlias('sb01', 'dev:123');
    expect(result).toEqual({ isNewDevice: true, isSwap: false });
  });

  it('detects Notecard swap when device_uid differs', async () => {
    // getAliasBySerial returns existing alias with different device_uid
    ddbMock.on(GetCommand).resolves({
      Item: {
        serial_number: 'sb01',
        device_uid: 'dev:old',
        created_at: 1000,
        updated_at: 1000,
      },
    });
    // updateAliasOnSwap succeeds
    ddbMock.on(UpdateCommand).resolves({});

    const result = await handleDeviceAlias('sb01', 'dev:new');
    expect(result).toEqual({
      isNewDevice: false,
      isSwap: true,
      oldDeviceUid: 'dev:old',
    });
  });

  it('returns no changes when device_uid matches', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        serial_number: 'sb01',
        device_uid: 'dev:123',
        created_at: 1000,
        updated_at: 1000,
      },
    });

    const result = await handleDeviceAlias('sb01', 'dev:123');
    expect(result).toEqual({ isNewDevice: false, isSwap: false });
  });
});
