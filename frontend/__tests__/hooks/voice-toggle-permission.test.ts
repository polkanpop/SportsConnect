/**
 * voice-toggle-permission.test.ts — Tests for the voice toggle permission flow.
 *
 * Validates:
 *   - Turn ON when mic already granted → enable immediately (no dialog)
 *   - Turn ON when mic not granted → request → if granted, enable
 *   - Turn ON when mic not granted → request → if denied, stay off
 *   - Turn OFF → always succeeds, no permission check needed
 *   - Previously granted then disabled → re-enable → no permission dialog
 */

describe('VoiceToggleSection permission logic', () => {
  let mockGetPermissions: jest.Mock
  let mockRequestPermissions: jest.Mock
  let mockSetEnabled: jest.Mock

  beforeEach(() => {
    mockGetPermissions = jest.fn()
    mockRequestPermissions = jest.fn()
    mockSetEnabled = jest.fn()
  })

  // Simulate the handleToggle logic from VoiceToggleSection
  async function handleToggle(val: boolean) {
    if (!val) {
      mockSetEnabled(false)
      return
    }
    const { granted } = await mockGetPermissions()
    if (granted) {
      mockSetEnabled(true)
      return
    }
    const { granted: nowGranted } = await mockRequestPermissions()
    if (nowGranted) {
      mockSetEnabled(true)
    }
    // If denied, don't call setEnabled — Switch stays off
  }

  it('turns OFF without checking permissions', async () => {
    await handleToggle(false)
    expect(mockSetEnabled).toHaveBeenCalledWith(false)
    expect(mockGetPermissions).not.toHaveBeenCalled()
    expect(mockRequestPermissions).not.toHaveBeenCalled()
  })

  it('turns ON immediately when mic already granted', async () => {
    mockGetPermissions.mockResolvedValue({ granted: true })
    await handleToggle(true)
    expect(mockSetEnabled).toHaveBeenCalledWith(true)
    expect(mockRequestPermissions).not.toHaveBeenCalled()
  })

  it('requests permission when not granted, enables if user accepts', async () => {
    mockGetPermissions.mockResolvedValue({ granted: false })
    mockRequestPermissions.mockResolvedValue({ granted: true })
    await handleToggle(true)
    expect(mockRequestPermissions).toHaveBeenCalled()
    expect(mockSetEnabled).toHaveBeenCalledWith(true)
  })

  it('stays OFF when user denies permission', async () => {
    mockGetPermissions.mockResolvedValue({ granted: false })
    mockRequestPermissions.mockResolvedValue({ granted: false })
    await handleToggle(true)
    expect(mockRequestPermissions).toHaveBeenCalled()
    expect(mockSetEnabled).not.toHaveBeenCalled()
  })

  it('re-enable after disable skips permission dialog (already granted)', async () => {
    // First enable: permission gets granted
    mockGetPermissions.mockResolvedValue({ granted: false })
    mockRequestPermissions.mockResolvedValue({ granted: true })
    await handleToggle(true)
    expect(mockSetEnabled).toHaveBeenCalledWith(true)
    mockSetEnabled.mockClear()

    // Disable
    await handleToggle(false)
    expect(mockSetEnabled).toHaveBeenCalledWith(false)
    mockSetEnabled.mockClear()
    mockRequestPermissions.mockClear()

    // Re-enable: permission already granted
    mockGetPermissions.mockResolvedValue({ granted: true })
    await handleToggle(true)
    expect(mockSetEnabled).toHaveBeenCalledWith(true)
    // Should NOT have shown permission dialog again
    expect(mockRequestPermissions).not.toHaveBeenCalled()
  })
})
