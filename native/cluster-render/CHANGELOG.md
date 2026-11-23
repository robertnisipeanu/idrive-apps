# Changelog

## Unreleased

## 0.8.3
A mesh part can draw lines, a line loop, points or a triangle strip as well
as triangles, and draw its geometry up to 256 times at once (instances),
for gauge ticks, star fields or rows of identical shapes sent once. What
the mesh layers on a target draw is bounded: a part's indices times its
instances, a layer's parts together and every mesh layer on the target.
Effect layers and mesh parts take GLSL ES 3.00 shaders.

Animations can be eased (`ease_in`, `ease_out`, `ease_in_out`) or follow a
smooth curve through their keys, played by the cluster with nothing sent
per frame. A mesh part can follow another part or a pivot that draws
nothing, so one animation moves everything attached to it. On iDrive 7,
replacing or stopping an animation (a needle sent a new value) no longer
makes every animation on the cluster again each time: a replacement sends
its own keys, and only once the replaced and stopped ones' keys outnumber
the live ones' are the live ones made again, a few at a time. Animation keys
go within a share of the upload cap of their own, split between the
targets, so animations and writes never wait on each other, and together
stay within the cap.

## 0.8.4

The cluster map no longer keeps disappearing about 2 seconds after it shows,
which could go on for minutes after a head-unit restart with a cluster theme
installed. The service no longer takes the map down as not drawn while the
car's logging has RAMSES's messages turned off, since it cannot see then
whether the cluster draws it.

The C++ client library sends every repeated map frame to a service without
repeats, also one that comes while the frame before is still being sent;
it used to drop it.

## 0.8.3

Canvases: an app's effect and mesh layers can draw into an off-screen
picture of its own, which its layers on screen then show like an asset.
A canvas can have its own depth and stencil buffer, for masks and depth
tests that never touch the display's, and can be drawn once and kept until
something it shows or samples changes. A canvas drawn every frame is
skipped while nothing shown samples it. The client libraries send canvases
only to a service that takes them.

## 0.8.2

An app that draws the cluster with layers only, such as a cluster theme,
can show another app's picture (Waze's map) inside it with no scene file:
`host` with `into`. The picture is drawn under the app's layers, and goes
back to its own place when the app hides its layers, ends the host
(`unhost`) or exits, or the panel is taken. Of several such apps the one
drawn highest over the picture wins, and an app showing a scene file that
hosts the picture wins over them; the `hosting` event tells each app why it
waits.

## 0.8.1

Effect layers and mesh parts choose how they blend (presets such as
`premultiplied`, `max` and `subtract`, or their own factors and
operations) and which colour channels they write, and a part its depth
test. Assets can be sampled with mipmaps (the service makes the levels of
`rgba8` and `r8` assets; a compressed one brings its own), mirrored, with
each axis wrapped its own way and anisotropically. A shader is at most
64 KB.

## 0.8.0

A layer can ask for upload bandwidth while it is shown (`others_fps`): the
other apps' videos are then written at most that many times a second, 15
at the least, until the layer is hidden or goes or its app exits. The apps
held are told (`fps_cap`).

## 0.7.0

A layer can ask for its target's scene to stay loaded on the cluster while
nothing shows it, so the target appears without loading again when a layer
wants it (`preload`).

