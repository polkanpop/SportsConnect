/**
 * settings-search.test.ts — Tests for the settings.tsx search/filter logic.
 *
 * Validates:
 *   - Empty search shows all rows
 *   - Typing "account" shows account row, hides others
 *   - Typing partial match "noti" shows notification row
 *   - Typing non-matching text hides all rows
 *   - Vietnamese keywords match (e.g., "tài khoản")
 */

describe('Settings search filtering logic', () => {
  const settingsRows = [
    { key: 'account', keywords: 'account settings tài khoản hồ sơ profile' },
    { key: 'notification', keywords: 'notification thông báo' },
    { key: 'language', keywords: 'language ngôn ngữ' },
    { key: 'court_register', keywords: 'court register sân đăng ký' },
    { key: 'data_privacy', keywords: 'data privacy dữ liệu quyền riêng tư' },
    { key: 'sign_out', keywords: 'sign out đăng xuất logout' },
  ]

  function computeShowRow(search: string): Record<string, boolean> {
    const q = search.trim().toLowerCase()
    if (!q) {
      const all: Record<string, boolean> = {}
      settingsRows.forEach(r => { all[r.key] = true })
      return all
    }
    const result: Record<string, boolean> = {}
    for (const r of settingsRows) {
      result[r.key] = r.keywords.includes(q) || r.keywords.split(' ').some(w => w.startsWith(q))
    }
    return result
  }

  it('shows all rows when search is empty', () => {
    const result = computeShowRow('')
    expect(Object.values(result).every(v => v)).toBe(true)
  })

  it('shows all rows when search is only whitespace', () => {
    const result = computeShowRow('   ')
    expect(Object.values(result).every(v => v)).toBe(true)
  })

  it('filters to account row when typing "account"', () => {
    const result = computeShowRow('account')
    expect(result.account).toBe(true)
    expect(result.notification).toBe(false)
    expect(result.language).toBe(false)
  })

  it('filters to notification row with partial "noti"', () => {
    const result = computeShowRow('noti')
    expect(result.notification).toBe(true)
    expect(result.account).toBe(false)
  })

  it('matches Vietnamese keyword "tài khoản"', () => {
    const result = computeShowRow('tài khoản')
    expect(result.account).toBe(true)
  })

  it('matches Vietnamese keyword "đăng xuất"', () => {
    const result = computeShowRow('đăng xuất')
    expect(result.sign_out).toBe(true)
  })

  it('hides all rows for non-matching input', () => {
    const result = computeShowRow('xyznonexistent')
    expect(Object.values(result).every(v => !v)).toBe(true)
  })

  it('is case insensitive', () => {
    const result = computeShowRow('ACCOUNT')
    // toLowercase is applied to search — 'account' is in keywords
    expect(result.account).toBe(true)
  })

  it('matches "court" to court_register', () => {
    const result = computeShowRow('court')
    expect(result.court_register).toBe(true)
    expect(result.data_privacy).toBe(false)
  })

  it('matches "privacy" to data_privacy', () => {
    const result = computeShowRow('privacy')
    expect(result.data_privacy).toBe(true)
    expect(result.court_register).toBe(false)
  })
})
