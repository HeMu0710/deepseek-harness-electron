/** Electron IPC channel carrying one serialized fetch request. */
export const FETCH_CHANNEL = 'dsh:desktop:fetch'

/** Electron IPC channel cancelling a serialized fetch request. */
export const CANCEL_CHANNEL = 'dsh:desktop:cancel'

/** Electron IPC channel pulling one response-body chunk. */
export const PULL_CHANNEL = 'dsh:desktop:pull'

/** Electron IPC channel exposing renderer-safe application metadata. */
export const DESKTOP_INFO_CHANNEL = 'dsh:desktop:info'

/** Electron IPC channel saving one Host-streamed download through an OS dialog. */
export const SAVE_DOWNLOAD_CHANNEL = 'dsh:desktop:save-download'
