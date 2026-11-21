# Changelog

## Unreleased

A layer can ask for upload bandwidth while it is shown (`others_fps`): the
other apps' videos are then written at most that many times a second, 15
at the least, until the layer is hidden or goes or its app exits. The apps
held are told (`fps_cap`).

## 0.7.0

A layer can ask for its target's scene to stay loaded on the cluster while
nothing shows it, so the target appears without loading again when a layer
wants it (`preload`).

