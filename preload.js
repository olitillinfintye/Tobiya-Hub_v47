const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (channel) => (payload) => ipcRenderer.invoke(channel, payload);

contextBridge.exposeInMainWorld('vr', {
  /** Disk path of a file dropped onto the window (File.path was removed in Electron 32). */
  pathForFile: (file) => {
    try { return webUtils.getPathForFile(file); } catch { return ''; }
  },
  listDevices: invoke('devices:list'),
  adbStatus: invoke('adb:status'),
  fixAdb: invoke('adb:fix'),
  renameDevice: invoke('devices:rename'),
  deleteDevice: invoke('devices:delete'),
  deleteAllDevices: invoke('devices:deleteAll'),
  stopForeground: invoke('ctl:stopForeground'),
  wifiMode: invoke('devices:wifi'),
  connectIp: invoke('devices:connect'),
  disconnectIp: invoke('devices:disconnect'),
  screenshot: invoke('devices:screenshot'),

  startRecording: invoke('record:start'),
  stopRecording: invoke('record:stop'),
  recordingStatus: invoke('record:status'),
  openRecordingsFolder: invoke('record:openFolder'),
  listRecordings: invoke('record:list'),
  playRecording: invoke('record:play'),
  deleteRecording: invoke('record:delete'),
  showFile: invoke('files:show'),
  saveShot: invoke('files:saveShot'),
  exportFiles: invoke('files:export'),
  chooseFilesDir: invoke('files:chooseDir'),

  listApps: invoke('apps:list'),
  launchApp: invoke('apps:launch'),
  stopApp: invoke('apps:stop'),
  installApk: invoke('apps:installDialog'),
  onTransferProgress: (cb) => ipcRenderer.on('transfer:progress', (e, p) => cb(p)),

  pushVideo: invoke('video:pickAndPush'),
  knownVideos: invoke('video:listKnown'),
  listDeviceVideos: invoke('video:listOnDevice'),
  playVideo: invoke('video:play'),
  pauseVideo: invoke('video:pauseToggle'),
  stopVideo: invoke('video:stop'),

  setVolume: invoke('ctl:volume'),
  setBrightness: invoke('ctl:brightness'),
  sendKey: invoke('ctl:key'),
  reboot: invoke('ctl:reboot'),
  powerOff: invoke('ctl:poweroff'),

  openWall: invoke('wall:open'),
  isWallOpen: invoke('wall:isOpen'),
  onWallState: (cb) => ipcRenderer.on('wall:state', (e, open) => cb(open)),
  onWallFocus: (cb) => ipcRenderer.on('wall:focus', (e, serial) => cb(serial)),
  startCast: invoke('cast:start'),
  stopCast: invoke('cast:stop'),
  reportCastSize: invoke('cast:nativeSize'),
  onCastData: (cb) => ipcRenderer.on('cast:data', (e, serial, data) => cb(serial, data)),
  onCastEvent: (cb) => ipcRenderer.on('cast:event', (e, serial, kind, msg) => cb(serial, kind, msg)),

  openScrcpy: invoke('scrcpy:open'),

  getSettings: invoke('settings:get'),
  setSettings: invoke('settings:set'),
  pickAdb: invoke('settings:pickAdb'),
  onSettingsChanged: (cb) => ipcRenderer.on('settings:changed', (e, s) => cb(s)),
  getStats: invoke('stats:get'),
  clearStats: invoke('stats:clear'),
  openDataFolder: invoke('data:openFolder'),

  getLicense: invoke('license:get'),
  activateLicense: invoke('license:activate'),

  checkForUpdates: invoke('update:check'),
  installUpdate: invoke('update:install'),
  onUpdateChecking: (cb) => ipcRenderer.on('update:checking', () => cb()),
  onUpdateAvailable: (cb) => ipcRenderer.on('update:available', (e, info) => cb(info)),
  onUpdateNone: (cb) => ipcRenderer.on('update:none', () => cb()),
  onUpdateProgress: (cb) => ipcRenderer.on('update:progress', (e, pct) => cb(pct)),
  onUpdateDownloaded: (cb) => ipcRenderer.on('update:downloaded', (e, info) => cb(info)),
  onUpdateError: (cb) => ipcRenderer.on('update:error', (e, msg) => cb(msg)),
});
