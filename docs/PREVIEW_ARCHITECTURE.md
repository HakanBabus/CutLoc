# Preview and export architecture

CutLoc uses one visual compositor. The editor canvas and exported MP4 frames
are both rasterized by Chromium from the same React/CSS/SVG composition tree:

```text
ProjectSchema -> evaluateFrameRenderPlan()
  -> Chromium compositor (live canvas and deterministic export frames)
  -> FFmpeg (audio processing, H.264/AAC encoding, and MP4 muxing only)
```

## Contract

- `evaluateFrameRenderPlan()` owns integer `frameIndex`, timeline time, visible
  stack order, source-time mapping, keyframes, transitions, crop/fit geometry,
  adjustment filters, muting, and audio gain in `packages/shared`.
- Chromium is the visual source of truth. There is no separate paused proof
  layer and no second FFmpeg visual interpretation.
- React owns controls, selection, and overlays; it does not define composition
  semantics.
- Canvas zoom scales the completed canvas and never changes authored layout.
- The playback clock publishes no more than one editor update per authored
  frame. Media drift correction uses an FPS-relative tolerance.

## Implemented flow

1. Project state is validated by `ProjectSchema`.
2. `visualLayerPlan()` establishes one back-to-front stack.
3. `evaluateFrameRenderPlan()` quantizes time and evaluates the frame.
4. The fast backend mounts decoded media ahead of cuts and applies only the
   plan's numeric results. Browser media elements retain platform hardware
   decoding; CSS/SVG layers retain GPU composition and interactive hit targets.
5. Export opens a chrome-free renderer route at the requested output size,
   seeks to each quantized frame, and captures the same `.canvas-frame` tree.
6. A small page pool renders frames in parallel and sends ordered lossless PNG
   frames to FFmpeg. FFmpeg processes audio and performs encoding/muxing.
7. The preview-frame API uses the same renderer route and revision cache.

WebCodecs was deliberately not made the primary decoder. It would require a
new demuxing and buffering subsystem while providing no automatic visual
parity; the browser's media pipeline already supplies hardware decode, seeking,
and buffering. A worker/WebCodecs backend remains an optional future
optimization for measured high-layer-count bottlenecks, not a correctness
dependency.

## Parity gates

- Shared tests freeze frame index, source time, keyframes, transitions,
  adjustment filters, geometry, fade, and audio values.
- Server tests decode exported frames and assert position and animated-scale
  pixel bounds, in addition to crop, mask, speed-curve, adjustment, and text
  compositor coverage.
- Browser tests verify that playback and pause keep the same live canvas and
  never switch to a proof-image overlay.
- Preview requests are abortable, revision-keyed, concurrency-limited, cached,
  and excluded from unsafe server shutdown.

Preview zoom changes only presentation size. Authored geometry stays in canvas
coordinates, while export renders that same composition at the requested pixel
dimensions. Browser codec decoding can still vary by platform, but CutLoc no
longer has two independent implementations of layout, typography, masks,
filters, or transitions.

## References

- [WebCodecs](https://www.w3.org/TR/webcodecs/)
- [Web Audio](https://www.w3.org/TR/webaudio/)
- [OffscreenCanvas](https://html.spec.whatwg.org/multipage/canvas.html)
- [WebGPU](https://www.w3.org/TR/webgpu/all/)
- [FFmpeg](https://ffmpeg.org/ffmpeg.html)
- [Frontstage](https://github.com/x777/frontstage), an example of separating a
  headless editor domain from a browser rendering engine
- [Remotion renderer](https://github.com/remotion-dev/remotion/tree/main/packages/renderer)
