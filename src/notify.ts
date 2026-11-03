import { spawnSync } from 'node:child_process';

/** Best-effort desktop notification. Silent where the platform has no notifier. */
export function notify(title: string, message: string): void {
  const text = message.split('\n')[0]!.slice(0, 200);
  if (process.platform === 'darwin') {
    spawnSync('osascript', ['-e', `display notification ${JSON.stringify(text)} with title ${JSON.stringify(title)}`]);
  } else if (process.platform === 'linux') {
    spawnSync('notify-send', [title, text]);
  }
}
