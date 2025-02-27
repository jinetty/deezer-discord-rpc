import { join } from 'path';
import updater from './Updater';
import { clientId, noWsActivity, useAsMainApp } from '../variables';
import * as Config from './Config';
import * as RPC from './RPC';
import { prompt } from '../functions';
import { dialog, Menu, Tray } from 'electron';
import { version } from '../../package.json';
import { log } from './Log';
import { win } from './Window';
import * as DiscordWebSocket from './DiscordWebSocket';

const iconPath = join(__dirname, '..', 'img', 'IconTemplate@2x.png');

export let tray: Tray | null = null;
export async function init(app: Electron.App, client: import('discord-rpc').Client) {
  app?.whenReady().then(() => {
    tray = new Tray(iconPath);
    const contextMenu = Menu.buildFromTemplate([
      { label: 'Deezer Discord RPC', type: 'normal', click: () => win.show() },
      { label: `Version: ${version}${process.argv0.includes('node') ? ' (debug)' : ''}`, type: 'normal', enabled: false },
      { label: 'Check for updates', type: 'normal', click: () => updater() },
      { type: 'separator' },
      {
        label: 'Tooltip text', type: 'submenu', submenu: [
          ['App name', 'app_name'],
          ['App version', 'app_version'],
          ['App name and version', 'app_name_and_version'],
          ['Artists song - Song title', 'artists_and_title'],
          ['Song title - Artists song', 'title_and_artists'],
        ].map(v => ({
          label: v[0], type: 'radio', id: v[1], checked: Config.get(app, 'tooltip_text') === v[1],
          click: (menuItem) => Config.set(app, 'tooltip_text', menuItem.id)
        }))
      },
      {
        label: 'Only show RPC if music is playing', type: 'checkbox', checked: Config.get(app, 'only_show_if_playing'),
        click: (menuItem) => Config.set(app, 'only_show_if_playing', menuItem.checked), enabled: useAsMainApp
      },
      {
        label: Config.get(app, 'use_listening_to') ? 'Reconnect to WebSocket' : 'Reconnect RPC', type: 'normal',
        click: () => {
          (
            Config.get(app, 'use_listening_to') ?
              DiscordWebSocket.connect(Config.get(app, 'discord_token'))
                .then(() => DiscordWebSocket.client.send(JSON.stringify(noWsActivity)))
                .catch(console.error) :
              client.connect(clientId)
          )
            .then(() => log(Config.get(app, 'use_listening_to') ? 'WebSocket' : 'RPC', 'Reconnected'))
            .catch(console.error)
        }
      },
      {
        label: 'Use "Listening to" instead of "Playing"', type: 'checkbox', checked: Config.get(app, 'use_listening_to'),
        click: async (menuItem) => {
          if (!menuItem.checked) {
            menuItem.enabled = false;
            menuItem.checked = true;
            await dialog.showMessageBox(null, {
              type: 'question',
              buttons: ['No', 'Yes'],
              title: 'Listening to status',
              message: 'Do you want to disable the "Listening to" status and use the "Playing" status?',
            }).then(({ response }) => {
              menuItem.enabled = true;
              if (response === 1) {
                menuItem.checked = false;
                Config.set(app, 'use_listening_to', false);
                RPC.client.login({ clientId }).catch(() => RPC.client.connect(clientId).catch(console.error));
              }
            });
          } else {
            await prompt('ws', app);
          }
        }
      },
      { type: 'separator' },
      {
        label: 'Quit', type: 'normal', click: () => {
          Config.get(app, 'use_listening_to') && DiscordWebSocket?.disconnect(1000);
          win.hide();
          app.quit();
          process.exit();
        }
      }
    ]);

    tray.setToolTip('Deezer Discord RPC');
    tray.setContextMenu(contextMenu);
    useAsMainApp && tray.on('click', () => win.show());
  });
}
