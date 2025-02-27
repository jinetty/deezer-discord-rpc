import { artistsSeparator, useAsMainApp, userAgents } from '../variables';
import { resolve } from 'path';
import loadAdBlock from './AdBlock';
import * as Config from './Config';
import * as DiscordWebSocket from './DiscordWebSocket';
import * as RPC from './RPC';
import { log } from './Log';
import { findTrackInAlbum, getAlbum } from '../activity/album';
import { getTrack } from '../activity/track';
import * as Spotify from './Spotify';
import { runJs, wait } from '../functions';
import { BrowserWindow, ipcMain, Menu, shell } from 'electron';
import { setActivity } from './Activity';
import * as DeezerWebSocket from './DeezerWebSocket';

export let win: BrowserWindow;
let currentTrack: CurrentTrack;

export async function load(app: Electron.App) {
  win = new BrowserWindow({
    width: useAsMainApp ? 1920 : 450,
    height: useAsMainApp ? 1080 : 575,
    minimizable: useAsMainApp,
    maximizable: useAsMainApp,
    closable: true,
    resizable: true,
    center: true,
    title: 'Deezer Discord RPC',
    webPreferences: {
      preload: resolve(__dirname, '..', 'preload.js')
    }
  });

  await loadAdBlock(app, win);

  const menu = [];
  process.platform === 'darwin' &&
  menu.push({ role: 'appMenu' });
  menu.push({
    label: 'Player',
    type: 'submenu',
    submenu: [
      {
        label: 'Play/Pause',
        accelerator: 'Shift+Space',
        click: async () => {
          const playing = await runJs('window.dzPlayer.playing');
          await runJs(`window.dzPlayer.control.${!playing ? 'play' : 'pause'}()`);
        }
      },
      {
        label: 'Previous',
        accelerator: 'Shift+Left',
        click: async () => await runJs(`window.dzPlayer.control.prevSong()`)
      },
      {
        label: 'Next',
        accelerator: 'Shift+Right',
        click: async () => await runJs(`window.dzPlayer.control.nextSong()`)
      },
      { type: 'separator' },
      {
        id: 'shuffle_mode',
        label: 'Shuffle mode',
        type: 'checkbox',
        click: async () => await runJs('document.querySelector(\'.player-options .svg-icon-group > .svg-icon-group-item:nth-child(3) > button\')?.click()'),
        checked: false, enabled: false
      }
    ]
  });
  menu.push({ role: 'editMenu' });
  menu.push({ role: 'viewMenu' });
  menu.push({ role: 'windowMenu' });
  const trayMenu = Menu.buildFromTemplate(menu);

  Menu.setApplicationMenu(trayMenu);
  win.setMenu(trayMenu);
  win.setMenuBarVisibility(true);

  await win.loadURL('https://www.deezer.com/login', {
    // The default user agent does not work with Deezer (the player does not update by itself)
    userAgent: userAgents.deezerApp
  });

  const updateMenu = async () => {
    log('Menu', 'Updating menu entries...');
    Menu.getApplicationMenu().getMenuItemById('shuffle_mode').enabled = true;
    Menu.getApplicationMenu().getMenuItemById('shuffle_mode').checked = await runJs('dzPlayer.isShuffle()');

    log('Menu', 'Updated menu entries');
    win.removeListener('page-title-updated', () => {});
  };

  win.on('page-title-updated', updateMenu);
  win.webContents.on('devtools-reload-page', updateMenu);

  win.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url);
    return { action: 'deny' };
  });

  win.on('close', (e) => {
    e.preventDefault();
    win.hide();

    return false;
  });

  wait(5000).then(() => {
    runJs(`document.querySelector('.slider-track-input.mousetrap').addEventListener('click', () => ipcRenderer.send('update_activity', 'update_activity'))`);
    ipcMain.on('update_activity', () => updateActivity(app, true));
    setInterval(() => updateActivity(app), 1000);
  });
}

const UpdateReason = {
  MUSIC_CHANGED: 'music got changed',
  MUSIC_PAUSED: 'music got paused',
  MUSIC_PLAYED: 'music got played',
  MUSIC_TIME_CHANGED: 'current song time changed',
  MUSIC_NOT_RIGHT_TIME: 'song time wasn\'t the right one'
};

async function updateActivity(app: Electron.App, currentTimeChanged?: boolean) {
  const client = (Config.get(app, 'use_listening_to') ? DiscordWebSocket : RPC).client;
  let code =
    `(() => {
      const albumId = document.querySelector('.track-link[href*="album"]')?.getAttribute('href').split('/')[3];
      const trackName = document.querySelector('.track-link[href*="album"]')?.textContent;
      const playing = dzPlayer.isPlaying();
      const songTime = parseInt(dzPlayer.getDuration()) * 1000;
      const timeLeft = Math.floor(dzPlayer.getRemainingTime() * 1000);
      return JSON.stringify({ albumId, trackName, playing, songTime, timeLeft });
    })()`;
  runJs(code).then(async (r) => {
    const result: JSResult = JSON.parse(r);
    const realSongTime = result.songTime;
    const songTime = Date.now() + realSongTime;
    const timeLeft = songTime - result.timeLeft;
    // @ts-ignore
    if (!currentTrack?.songTime) currentTrack?.songTime = realSongTime;
    if (
      currentTrack?.trackTitle !== result.trackName || currentTrack?.playing !== result.playing || currentTimeChanged === true ||
      currentTrack?.songTime !== realSongTime
    ) {
      let reason;
      if (currentTrack?.trackTitle !== result.trackName) {
        reason = UpdateReason.MUSIC_CHANGED;
      }
      else if (currentTrack?.playing !== result.playing) {
        reason = result.playing ? UpdateReason.MUSIC_PLAYED : UpdateReason.MUSIC_PAUSED;
      }
      else if (currentTimeChanged && currentTimeChanged === true) reason = UpdateReason.MUSIC_TIME_CHANGED;
      else if (currentTrack?.songTime !== realSongTime) reason = UpdateReason.MUSIC_NOT_RIGHT_TIME;
      log('Activity', 'Updating because', reason);
      const trackId = await findTrackInAlbum(result.trackName, result.albumId);
      const track = await getTrack(trackId);
      const album = await getAlbum(result.albumId);
      currentTrack = {
        trackId,
        trackTitle: track.title,
        trackArtists: track.contributors?.map(c => c.name)?.join(artistsSeparator),
        trackLink: track.link,
        // @ts-ignore
        albumCover: Config.get(app, 'use_listening_to') ?
          await Spotify.getCover({
            albumTitle: album.title, title: track.title, artists: track.contributors?.map(c => c.name)?.join(', ')
          }, app).catch(async () => {
            log('Spotify Covers', 'Access token expired; refreshing it');
            await Spotify.accessToken(Config.get(app, 'spotify_refresh_token')).then((res) => {
              const { access_token, expires_in, token_type } = res.data;
              Config.set(app, 'spotify_access_token', access_token);
              Config.set(app, 'spotify_expires_at', Date.now() + expires_in);
              Config.set(app, 'spotify_token_type', token_type);
            });
          }) :
          album.cover_medium,
        albumTitle: album.title,
        playing: result.playing
      };

      DeezerWebSocket.server?.send(JSON.stringify({
        type: 'message',
        event: DeezerWebSocket.events[(() => {
          switch (reason) {
            case UpdateReason.MUSIC_PAUSED:
            case UpdateReason.MUSIC_PLAYED:
            case UpdateReason.MUSIC_TIME_CHANGED:
              return 'PLAYER_STATE_CHANGED';
            case UpdateReason.MUSIC_CHANGED:
              return 'PLAYER_TRACK_CHANGED';
          }
        })()],
        data: (() => {
          switch (reason) {
            case UpdateReason.MUSIC_PAUSED:
              return { track, album, event: { playing: false } };
            case UpdateReason.MUSIC_PLAYED:
              return { track, album, event: { playing: true } };
            case UpdateReason.MUSIC_TIME_CHANGED:
              return { track, album, event: { time: Math.floor((timeLeft - Date.now()) / 1000) } };
            case UpdateReason.MUSIC_CHANGED:
              return { old: {}, new: { track, album } };
          }
        })()
      }));
      await setActivity({
        client, albumId: result.albumId, timeLeft, app, ...currentTrack, songTime
      }).then(() => log('Activity', 'Updated'));
    }
    currentTrack.songTime = realSongTime;
    currentTrack.trackTitle = result.trackName;
    currentTrack.playing = result.playing;
  });
}

interface CurrentTrack {
  songTime: number,
  trackId: number,
  trackTitle: string,
  trackArtists: string,
  trackLink: string,
  albumTitle: string,
  albumCover: string,
  playing: boolean,
}

interface JSResult {
  songTime: number,
  timeLeft: number,
  trackName: string,
  albumId: number,
  playing: boolean,
}
