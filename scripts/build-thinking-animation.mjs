import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

// Use raster artwork so the center stays fixed and the brackets do not drift.
const dir = '.qa/span-thinking-orbit';
const assets = 'apps/desktop/src/renderer/src/assets';
mkdirSync(dir, { recursive: true });
const magick = (...args) => execFileSync('magick', args, { stdio: 'pipe' });
magick('brand/span-512.png', '-colorspace', 'Gray', '-threshold', '70%', `${dir}/white-mask.png`);
magick('-size', '512x512', 'xc:white', `${dir}/white-mask.png`, '-alpha', 'off', '-compose', 'CopyOpacity', '-composite', `${dir}/brackets.png`);
magick('brand/span-512.png', '-crop', '84x84+209+211', '+repage', `${dir}/center.png`);
const ease = t => t * t * (3 - 2 * t);
const frames = [];
for (let i = 0; i < 72; i++) {
  const t = i / 72;
  let scale = 1;
  let angle = 0;
  if (t >= 0.08 && t < 0.28) scale = 1 - 0.4 * ease((t - 0.08) / 0.2);
  else if (t >= 0.28 && t < 0.72) { scale = 0.6; angle = 360 * ease((t - 0.28) / 0.44); }
  else if (t >= 0.72 && t < 0.92) { scale = 0.6 + 0.4 * ease((t - 0.72) / 0.2); angle = 360; }
  const frame = `${dir}/frame-${String(i).padStart(3, '0')}.png`;
  magick(`${dir}/brackets.png`, '-virtual-pixel', 'transparent', '-distort', 'SRT', `251,253 ${scale} ${angle} 251,253`, `${dir}/moving.png`);
  magick('-size', '512x512', 'xc:#0b1930', `${dir}/center.png`, '-geometry', '+209+211', '-compose', 'Over', '-composite', `${dir}/moving.png`, '-geometry', '+0+0', '-compose', 'Over', '-composite', '-resize', '96x96', frame);
  frames.push(frame);
}
magick('-delay', '5', ...frames, '-loop', '0', '-layers', 'Optimize', `${assets}/span-thinking.gif`);
magick(frames[0], `${assets}/span-thinking-still.png`);
magick(frames[0], frames[14], frames[25], frames[30], frames[36], frames[42], frames[55], frames[71], '+append', `${dir}/contact.png`);
console.log('Built 72-frame, 3.6-second thinking loop.');
