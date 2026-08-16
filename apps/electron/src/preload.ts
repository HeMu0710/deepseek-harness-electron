/** Isolated renderer bridge for the desktop fetch carrier. */

import { contextBridge, ipcRenderer } from 'electron'
import {
  CANCEL_CHANNEL,
  DESKTOP_INFO_CHANNEL,
  FETCH_CHANNEL,
  PULL_CHANNEL,
  SAVE_DOWNLOAD_CHANNEL,
} from './channels.ts'
import type {
  DesktopFetchChunk,
  DesktopFetchHead,
  DesktopFetchRequest,
  DesktopInfo,
} from './protocol.ts'

/** API exposed through context isolation; implemented without exporting ipcRenderer. */
export interface DesktopRendererBridge {
  /** Submit one serialized request. */
  fetch(request: DesktopFetchRequest): Promise<DesktopFetchHead>
  /** Pull one response-body chunk with utility-process backpressure. */
  pull(id: string): Promise<DesktopFetchChunk>
  /** Cancel a submitted request. */
  cancel(id: string): Promise<void>
  /** Read immutable desktop metadata. */
  info(): Promise<DesktopInfo>
  /** Save one Host download after the main process obtains an OS-approved path. */
  saveDownload(url: string, filename: string): Promise<boolean>
}

const bridge: DesktopRendererBridge = {
  fetch: request => ipcRenderer.invoke(FETCH_CHANNEL, request) as Promise<DesktopFetchHead>,
  pull: id => ipcRenderer.invoke(PULL_CHANNEL, id) as Promise<DesktopFetchChunk>,
  cancel: async (id) => { await ipcRenderer.invoke(CANCEL_CHANNEL, id) },
  info: () => ipcRenderer.invoke(DESKTOP_INFO_CHANNEL) as Promise<DesktopInfo>,
  saveDownload: (url, filename) => ipcRenderer.invoke(SAVE_DOWNLOAD_CHANNEL, { url, filename }) as Promise<boolean>,
}

contextBridge.exposeInMainWorld('__DSH_DESKTOP__', bridge)
