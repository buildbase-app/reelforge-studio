import React from 'react';
import { Img, useCurrentFrame } from 'remotion';
import type { LogoRef, MediaRef, SceneMedia } from '@reelforge/project-schema';
import { mediaKey, mediaUrlAt } from '@reelforge/project-schema/media';

/**
 * Background media and logo for Remotion templates (#299). Pictures come
 * from the render's own loopback asset origin (`__assets`, staged by
 * src/render.ts); a video is one picture per frame, so frame n shows picture
 * n: frame-pure, the same in a frame-range chunk as in a whole render.
 * Remotion's <Img> holds the frame until the picture has loaded.
 */

export const BackgroundMedia: React.FC<{ media: MediaRef; assets: Record<string, SceneMedia>; unit: number }> = ({ media, assets, unit }) => {
  const frame = useCurrentFrame();
  const m = assets[mediaKey(media.asset, media.start)];
  if (!m) return null;
  const src = mediaUrlAt(m, frame);
  const pos = `${media.focus?.x ?? 50}% ${media.focus?.y ?? 50}%`;
  const fill: React.CSSProperties = { position: 'absolute', inset: 0, width: '100%', height: '100%', objectPosition: pos };
  return (
    <div style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}>
      {media.fit === 'blur-fill' ? <Img src={src} style={{ ...fill, objectFit: 'cover', filter: `blur(${3 * unit}px)`, transform: 'scale(1.08)' }} /> : null}
      <Img src={src} style={{ ...fill, objectFit: media.fit === 'cover' ? 'cover' : 'contain' }} />
    </div>
  );
};

export const Logo: React.FC<{ logo: LogoRef; assets: Record<string, SceneMedia>; unit: number; box: { x: number; y: number; width: number; height: number }; width: number; height: number }> = ({ logo, assets, unit, box, width, height }) => {
  const m = assets[logo.asset];
  if (!m) return null;
  const [v, h] = logo.corner.split('-') as ['top' | 'bottom', 'left' | 'right'];
  const size = logo.size * unit;
  return (
    <Img
      src={m.url}
      style={{
        position: 'absolute',
        [v]: v === 'top' ? box.y : height - box.y - box.height,
        [h]: h === 'left' ? box.x : width - box.x - box.width,
        width: size,
        height: size,
        objectFit: 'contain',
        objectPosition: `${h} ${v}`,
      }}
    />
  );
};
