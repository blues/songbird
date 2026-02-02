---
planStatus:
  planId: plan-lock-override-command
  title: Transit/Demo Lock Override Command
  status: completed
  planType: feature
  priority: high
  owner: satch
  tags:
    - dashboard
    - commands
    - firmware
    - security
  created: "2025-01-30"
  updated: "2025-01-31T00:30:00.000Z"
  progress: 100
---
# Transit/Demo Lock Override Command

## Goals
- Allow admins and device owners to remotely unlock a device stuck in transit or demo lock
- Deliver unlock via inbound command (not environment variable) for immediate action
- Restrict access to authorized users only (admins + device owners)

## Overview

Devices can enter a "locked" state via physical button interactions:
- **Transit Lock**: Single-click locks device in transit mode for shipping
- **Demo Lock**: Double-click locks device in demo mode for presentations

If a device gets into a bad state (stuck in wrong lock mode, shipped to wrong location, needs mode change during demo), there's currently no way to remotely override the lock. This feature adds an `unlock` command that can be sent from the dashboard.

## Implementation Details

### 1. Firmware Changes (`songbird-firmware/`)

**File: \****`src/commands/command_handler.cpp`**

Add handler for new `unlock` command:

```cpp
// New command type
void handleUnlockCommand(const J* params) {
  const char* lockType = JGetString(params, "lock_type");  // "transit", "demo", or "all"

  if (strcmp(lockType, "transit") == 0 || strcmp(lockType, "all") == 0) {
    clearTransitLock();
  }
  if (strcmp(lockType, "demo") == 0 || strcmp(lockType, "all") == 0) {
    clearDemoLock();
  }

  // Send acknowledgment
  sendCommandAck("unlock", true, "Lock cleared");

  // Play confirmation melody
  playMelody(MELODY_COMMAND_RECEIVED);
}
```

**File: \****`src/core/mode_manager.cpp`**

Add functions to clear lock states:
- `clearTransitLock()` - Clear transit lock flag, allow mode changes
- `clearDemoLock()` - Clear demo lock flag, allow mode changes

### 2. Infrastructure Changes (`songbird-infrastructure/`)

**File: \****`lambda/commands/index.ts`**

Add `unlock` to allowed command types with authorization check:

```typescript
const COMMANDS_REQUIRING_OWNERSHIP = ['unlock'];

// In handler:
if (COMMANDS_REQUIRING_OWNERSHIP.includes(commandType)) {
  const isAdmin = userGroups.includes('Admin');
  const isOwner = device.assignedTo === userId;

  if (!isAdmin && !isOwner) {
    return {
      statusCode: 403,
      body: JSON.stringify({ error: 'Only admins and device owners can send unlock commands' })
    };
  }
}

// Build command payload
const commandPayload = {
  type: 'unlock',
  lock_type: body.lockType || 'all'  // "transit", "demo", or "all"
};
```

### 3. Dashboard Changes (`songbird-dashboard/`)

**File: \****`src/api/commands.ts`**

Add unlock command function:

```typescript
export async function sendUnlockCommand(
  serialNumber: string,
  lockType: 'transit' | 'demo' | 'all' = 'all'
) {
  return sendCommand(serialNumber, 'unlock', { lockType });
}
```

**File: \****`src/components/DeviceCommands.tsx`** (or similar)

Add UI for unlock command:
- Button in device actions menu (only visible to admins + device owners)
- Confirmation dialog explaining the action
- Dropdown to select lock type (Transit, Demo, or Both)

**File: \****`src/hooks/useDevicePermissions.ts`** (new or existing)

Add permission check:

```typescript
export function canUnlockDevice(device: Device, user: User): boolean {
  const isAdmin = user.groups.includes('Admin');
  const isOwner = device.assignedTo === user.userId;
  return isAdmin || isOwner;
}
```

### Security Considerations

1. **Authorization**: Double-check both backend (Lambda) and frontend (hide button)
2. **Audit Trail**: Log unlock commands in activity feed with who sent them
3. **Rate Limiting**: Consider limiting unlock attempts per device/time period
4. **Confirmation**: Require user confirmation before sending unlock

### Command Flow

```
Dashboard UI → API Gateway → Lambda (auth check) → Notehub API →
command.qi notefile → Device reads command → Clears lock →
Sends ACK via command_ack.qo → Lambda updates command status
```

## Acceptance Criteria

- [x] Firmware handles `unlock` command with lock_type parameter
- [x] Firmware clears appropriate lock state(s) when command received
- [x] Firmware sends command acknowledgment after processing
- [x] Lambda validates user is admin OR device owner before sending
- [x] Lambda rejects unlock commands from unauthorized users (403)
- [x] Dashboard shows unlock button only for authorized users
- [x] Dashboard includes confirmation dialog before sending
- [x] Activity feed logs unlock command with user who sent it (via existing command logging)
- [x] Command appears in device command history

## Testing

1. **Authorization**: Verify non-admin, non-owner cannot send unlock
2. **Admin Access**: Verify admin can unlock any device
3. **Owner Access**: Verify device owner can unlock their device
4. **Firmware**: Test transit unlock, demo unlock, and "all" unlock
5. **Edge Cases**: Device offline (command queued), rapid unlock attempts
