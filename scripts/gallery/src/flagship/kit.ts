/**
 * Flagship reels: one long HyperFrames composition per reel, written by hand.
 * The whole picture is a canvas drawn by `draw(t)`, a pure function of the
 * scene time; captions are DOM nodes whose opacity and offset the same seek
 * sets. The runtime seeks every timeline registered on `window.__hfAnime`, so
 * a frame never depends on the one before it.
 *
 * `window.__rfElements` holds how many shapes the last frame drew: the
 * preview and the tests read it to back the "1,000+ animated elements" claim.
 */
export interface FlagshipReel {
  slug: string;
  title: string;
  category: string;
  tags: string[];
  description: string;
  prompt: string;
  duration: number;
  html: string;
  /** Music bed from scripts/gallery/src/music.ts. */
  music?: 'pulse' | 'lofi' | 'drive' | 'ambient' | 'bright' | 'stomp';
}

const CANVAS = '<canvas id="cv" width="1080" height="1920" style="position:absolute;inset:0;width:1080px;height:1920px"></canvas>';

/** Wrap a scene into the HyperFrames composition the studio renders. */
export function composition(duration: number, html: string, css: string, script: string): string {
  return (
    `<div class="clip hf-root" data-start="0" data-duration="${duration}" style="position:absolute;inset:0;overflow:hidden;background:#0B1626">` +
    `<style>${css}</style>${CANVAS}${html}` +
    `<script>(function(){${script}
function seek(t){draw(Math.max(0,Math.min(${duration},t)))}
seek(0);
window.__rfSeek=seek;
window.__hfAnime=(window.__hfAnime||[]).concat([{seek:function(ms){seek(ms/1000)},pause:function(){},play:function(){}}]);
})();</script></div>`
  );
}
