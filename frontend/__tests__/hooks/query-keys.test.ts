/**
 * query-keys.test.ts — Verify query key factories produce stable, unique keys.
 *
 * Why: Typos in query keys silently break cache invalidation. These tests
 *      ensure every factory returns the expected shape so we catch regressions
 *      before they reach production.
 */

import { queryKeys } from '@/hooks/query-keys'

describe('queryKeys', () => {
  // ── Static keys ─────────────────────────────────────────────────────────
  it('courtInfo returns a stable tuple', () => {
    expect(queryKeys.courtInfo).toEqual(['courtinfo'])
  })

  it('eventsCombined returns a stable tuple', () => {
    expect(queryKeys.eventsCombined).toEqual(['eventsCombined'])
  })

  it('trainingSessionsCombined returns a stable tuple', () => {
    expect(queryKeys.trainingSessionsCombined).toEqual(['trainingSessionsCombined'])
  })

  it('userId returns a stable tuple', () => {
    expect(queryKeys.userId).toEqual(['userId'])
  })

  // ── Parameterised key factories ─────────────────────────────────────────
  describe('courtAvailability', () => {
    it('includes the courtid in the key', () => {
      expect(queryKeys.courtAvailability(42)).toEqual(['courtavailability', 42])
    })

    it('falls back to -1 when courtid is null', () => {
      expect(queryKeys.courtAvailability(null)).toEqual(['courtavailability', -1])
    })
  })

  describe('courtAvailabilityById', () => {
    it('includes availability id in the key', () => {
      expect(queryKeys.courtAvailabilityById(7)).toEqual(['courtavailability', 'by-id', 7])
    })

    it('falls back to -1 for null', () => {
      expect(queryKeys.courtAvailabilityById(null)).toEqual(['courtavailability', 'by-id', -1])
    })
  })

  describe('favouriteCourts', () => {
    it('produces distinct keys for ids-only vs full', () => {
      const idsKey  = queryKeys.favouriteCourts(1, true)
      const fullKey = queryKeys.favouriteCourts(1, false)
      expect(idsKey).not.toEqual(fullKey)
    })

    it('includes userid and defaults to full', () => {
      expect(queryKeys.favouriteCourts(99)).toEqual(['favouritecourts', 99, 'full'])
    })

    it('falls back to -1 for null userid', () => {
      expect(queryKeys.favouriteCourts(null, true)).toEqual(['favouritecourts', -1, 'ids'])
    })
  })

  describe('userInfo', () => {
    it('includes userid', () => {
      expect(queryKeys.userInfo(5)).toEqual(['userinfo', 5])
    })

    it('falls back for null', () => {
      expect(queryKeys.userInfo(null)).toEqual(['userinfo', -1])
    })
  })

  describe('dashboard', () => {
    it('includes userid', () => {
      expect(queryKeys.dashboard(10)).toEqual(['dashboard', 10])
    })
  })

  describe('booking keys', () => {
    it('courtBookingsUser includes userid', () => {
      expect(queryKeys.courtBookingsUser(3)).toEqual(['bookings', 'court', 3])
    })

    it('eventBookingsUser includes userid', () => {
      expect(queryKeys.eventBookingsUser(3)).toEqual(['bookings', 'event', 3])
    })

    it('trainingBookingsUser includes userid', () => {
      expect(queryKeys.trainingBookingsUser(3)).toEqual(['bookings', 'training', 3])
    })

    it('tsBookingsBySession includes sessionid', () => {
      expect(queryKeys.tsBookingsBySession(88)).toEqual(['bookings', 'by-session', 88])
    })

    it('eventBookingsByEvent includes eventid', () => {
      expect(queryKeys.eventBookingsByEvent(12)).toEqual(['bookings', 'by-event', 12])
    })
  })

  describe('playingCourts / playingCourtImages', () => {
    it('playingCourts includes courtid', () => {
      expect(queryKeys.playingCourts(5)).toEqual(['playingCourts', 5])
    })

    it('playingCourtImages serialises pcIds', () => {
      expect(queryKeys.playingCourtImages(1, [10, 20, 30])).toEqual([
        'playingCourtImages', 1, '10,20,30',
      ])
    })
  })

  describe('reviews', () => {
    it('handles no params', () => {
      expect(queryKeys.reviews()).toEqual(['reviews', null, null, null])
    })

    it('includes provided params', () => {
      expect(queryKeys.reviews({ userid: 1, targettype: 'court', targetid: 55 }))
        .toEqual(['reviews', 1, 'court', 55])
    })

    it('handles partial params', () => {
      expect(queryKeys.reviews({ targettype: 'event' }))
        .toEqual(['reviews', null, 'event', null])
    })
  })

  describe('map keys', () => {
    it('mapEventsInBounds includes bounds key', () => {
      expect(queryKeys.mapEventsInBounds('10_20_30_40')).toEqual(['map', 'events', '10_20_30_40'])
    })

    it('mapTSInBounds includes bounds key', () => {
      expect(queryKeys.mapTSInBounds('10_20_30_40')).toEqual(['map', 'trainingsessions', '10_20_30_40'])
    })
  })

  describe('created events/sessions', () => {
    it('createdEventsCombined includes userid', () => {
      expect(queryKeys.createdEventsCombined(7)).toEqual(['createdEventsCombined', 7])
    })

    it('createdTrainingSessionsCombined includes userid', () => {
      expect(queryKeys.createdTrainingSessionsCombined(7)).toEqual(['createdTrainingSessionsCombined', 7])
    })
  })

  // ── Uniqueness sanity check ─────────────────────────────────────────────
  it('all static keys are unique', () => {
    const statics = [
      queryKeys.courtInfo,
      queryKeys.eventsCombined,
      queryKeys.trainingSessionsCombined,
      queryKeys.userId,
    ]
    const serialised = statics.map(k => JSON.stringify(k))
    expect(new Set(serialised).size).toBe(serialised.length)
  })
})
