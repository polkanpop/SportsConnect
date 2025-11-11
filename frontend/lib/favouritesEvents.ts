
// this file use to handle the event change when user select the favourite courts on homepage ( event bus)
export type FavouriteChangedPayload = { userid: number }
type Listener = (payload: FavouriteChangedPayload) => void

class FavouritesEvents {
  private listeners: Set<Listener> = new Set()

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  emitFavouriteChanged(userid: number) {
    const payload: FavouriteChangedPayload = { userid }

    this.listeners.forEach(l => {
      try { l(payload) } catch (e) { console.warn('[favouritesEvents] listener error', e) }
    })
  }
}

export const favouritesEvents = new FavouritesEvents()
