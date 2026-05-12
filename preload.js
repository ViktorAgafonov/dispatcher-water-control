'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (cfg) => ipcRenderer.invoke('config:set', cfg),
  pollNow: () => ipcRenderer.invoke('poll:now'),
  onPollResult: (handler) => {
    const listener = (_e, data) => handler(data);
    ipcRenderer.on('poll-result', listener);
    return () => ipcRenderer.removeListener('poll-result', listener);
  },
  onPollResultDrainage: (handler) => {
    const listener = (_e, data) => handler(data);
    ipcRenderer.on('poll-result-drainage', listener);
    return () => ipcRenderer.removeListener('poll-result-drainage', listener);
  },
  getLogs: () => ipcRenderer.invoke('logs:get'),
  clearLogs: () => ipcRenderer.invoke('logs:clear'),
  onLogAppend: (handler) => {
    const listener = (_e, entry) => handler(entry);
    ipcRenderer.on('log-append', listener);
    return () => ipcRenderer.removeListener('log-append', listener);
  },
  onLogClear: (handler) => {
    const listener = () => handler();
    ipcRenderer.on('log-clear', listener);
    return () => ipcRenderer.removeListener('log-clear', listener);
  },
  getStats: () => ipcRenderer.invoke('stats:get'),
  getStatsDrainage: () => ipcRenderer.invoke('stats:get-drainage'),
  getStatsHistory: () => ipcRenderer.invoke('stats:get-history'),
  saveReport: (content, defaultName) => ipcRenderer.invoke('report:save', { content, defaultName }),
  hideToTray: () => ipcRenderer.invoke('app:hide'),
  quitApp: () => ipcRenderer.invoke('app:quit'),
  getVersion: () => ipcRenderer.invoke('app:version'),
});
