"""Reusable helpers for rendering MRC volume previews.

Why this exists
---------------
Multiple endpoints in ``app.py`` open a 3D MRC volume and render a 2D preview
(Class3D class averages, Refine3D / InitialModel slice views, MaskCreate
viewer, etc.). The naive approach — central slice + percentile(2, 98)
contrast — silently produces solid-black panels for volumes where the
density is sparse, off-centre, or occupies a small fraction of the box.
This is exactly what bit us with the RELION 5 precalculated tutorial
(`relion50_results`).

Rather than scattering the same try/except contrast guards through every
caller, this module centralises four small pieces of logic:

- :func:`pick_best_slice` — picks the slice along a given axis with the
  most density information (highest variance), with a degenerate-data
  fallback.
- :func:`auto_crop_to_density` — trims a 2D image to the bounding box of
  significant density, keeping a square crop. Makes off-centre maps
  fill the panel.
- :func:`auto_contrast` — returns ``(vmin, vmax)`` from a percentile
  range, falling back to absolute min/max when the percentiles collapse.
- :func:`render_volume_preview` — composes the three above and writes
  the result to a matplotlib axes.

Each function takes only the data it needs, so they can be reused
independently. Callers can switch the projection mode, contrast range,
cropping, colormap, etc. via keyword arguments — no magic numbers
hard-coded for one job type.
"""
from __future__ import annotations

from typing import Optional, Tuple, Literal

import numpy as np


# ---------------------------------------------------------------------------
# Slice / projection selection
# ---------------------------------------------------------------------------

ProjectionMode = Literal["auto", "best_slice", "mid_slice", "mip", "sum", "band_sum"]


def pick_best_slice(volume: np.ndarray, axis: int = 0) -> np.ndarray:
    """Return the 2D slice along ``axis`` with the highest variance.

    For class-average / refined volumes, the most informative 2D preview
    is usually the slice with the most density structure. Variance is a
    cheap, robust proxy for "how much is going on here". If the entire
    volume is constant (all-zero or all-equal), falls back to the central
    slice.
    """
    if volume.ndim != 3:
        return volume

    flat = np.moveaxis(volume, axis, 0).reshape(volume.shape[axis], -1)
    variances = flat.var(axis=1)
    if not np.isfinite(variances).any() or variances.max() <= 0:
        # All slices are constant — fall back to the middle one.
        return np.take(volume, volume.shape[axis] // 2, axis=axis)

    best = int(np.argmax(variances))
    return np.take(volume, best, axis=axis)


def project_volume(
    volume: np.ndarray,
    *,
    mode: ProjectionMode = "auto",
    axis: int = 0,
    sum_band_fraction: float = 0.1,
) -> np.ndarray:
    """Reduce a 3D volume to a 2D preview.

    Modes:
      - ``"best_slice"`` — pick the slice with the highest variance.
      - ``"mid_slice"`` — the central slice.
      - ``"mip"`` — maximum-intensity projection.
      - ``"sum"`` — full sum projection across the chosen axis (the
        RELION-GUI convention for class previews; what users expect).
      - ``"band_sum"`` — sum a thin band (``sum_band_fraction`` of
        slices) centred on the best-variance slice. Used as the
        ``"auto"`` fallback when a single slice is too flat to read.
      - ``"auto"`` — try ``best_slice``; if it's essentially flat
        (``std < 1e-6``), fall back to a band sum; final fallback is
        MIP.
    """
    if volume.ndim != 3:
        return volume

    if mode == "mid_slice":
        return np.take(volume, volume.shape[axis] // 2, axis=axis)

    if mode == "mip":
        return volume.max(axis=axis)

    if mode == "best_slice":
        return pick_best_slice(volume, axis=axis)

    if mode == "sum":
        return volume.sum(axis=axis)

    if mode == "band_sum":
        return _band_sum(volume, axis=axis, fraction=sum_band_fraction)

    # mode == "auto"
    candidate = pick_best_slice(volume, axis=axis)
    if float(candidate.std()) >= 1e-6:
        return candidate

    band = _band_sum(volume, axis=axis, fraction=sum_band_fraction)
    if float(band.std()) >= 1e-6:
        return band

    return volume.max(axis=axis)


def _band_sum(volume: np.ndarray, *, axis: int, fraction: float) -> np.ndarray:
    """Sum a band of slices centred on the highest-variance slice."""
    n_slices = volume.shape[axis]
    band = max(1, int(round(n_slices * fraction)))
    centre = int(np.argmax(
        np.moveaxis(volume, axis, 0).reshape(n_slices, -1).var(axis=1)
    ))
    half = band // 2
    lo = max(0, centre - half)
    hi = min(n_slices, lo + band)
    return np.take(volume, range(lo, hi), axis=axis).sum(axis=axis)


# ---------------------------------------------------------------------------
# Cropping
# ---------------------------------------------------------------------------

def auto_crop_to_density(
    image: np.ndarray,
    *,
    threshold_sigma: float = 1.0,
    pad_fraction: float = 1 / 12,
    keep_square: bool = True,
    min_size: int = 4,
) -> np.ndarray:
    """Trim ``image`` to the bounding box of pixels above ``mean + k*std``.

    Returns the cropped slice. If the threshold catches nothing, or the
    crop would be smaller than ``min_size``, the original image is
    returned unchanged. With ``keep_square=True`` the shorter axis is
    padded so the panel stays roughly square.
    """
    if image.ndim != 2 or image.size == 0:
        return image
    try:
        mean = float(image.mean())
        std = float(image.std())
        if std <= 0 or not np.isfinite(std):
            return image
        thr = mean + threshold_sigma * std
        mask = image > thr
        if not mask.any():
            return image

        ys, xs = np.where(mask)
        h, w = image.shape
        pad = max(h, w) * pad_fraction
        pad = max(1, int(round(pad)))

        y0 = max(0, int(ys.min()) - pad)
        y1 = min(h, int(ys.max()) + pad + 1)
        x0 = max(0, int(xs.min()) - pad)
        x1 = min(w, int(xs.max()) + pad + 1)

        if keep_square:
            ch, cw = y1 - y0, x1 - x0
            if ch > cw:
                diff = (ch - cw) // 2
                x0 = max(0, x0 - diff)
                x1 = min(w, x1 + diff)
            elif cw > ch:
                diff = (cw - ch) // 2
                y0 = max(0, y0 - diff)
                y1 = min(h, y1 + diff)

        if (y1 - y0) < min_size or (x1 - x0) < min_size:
            return image
        return image[y0:y1, x0:x1]
    except Exception:
        return image


# ---------------------------------------------------------------------------
# Contrast
# ---------------------------------------------------------------------------

def auto_contrast(
    image: np.ndarray,
    *,
    percentile: Tuple[float, float] = (1.0, 99.5),
) -> Tuple[float, float]:
    """Return ``(vmin, vmax)`` for matplotlib display.

    Uses percentile-based stretch. If the percentile range collapses
    (degenerate / mostly-background slice), falls back to absolute
    min/max; if even that collapses, returns ``(v, v + epsilon)`` so
    matplotlib's normalize never divides by zero.
    """
    try:
        vmin = float(np.percentile(image, percentile[0]))
        vmax = float(np.percentile(image, percentile[1]))
    except Exception:
        vmin = float(image.min()) if image.size else 0.0
        vmax = float(image.max()) if image.size else 1.0

    if not (np.isfinite(vmin) and np.isfinite(vmax)) or vmax - vmin < 1e-12:
        vmin = float(image.min()) if image.size else 0.0
        vmax = float(image.max()) if image.size else 1.0
        if vmax - vmin < 1e-12:
            vmax = vmin + 1e-6
    return vmin, vmax


# ---------------------------------------------------------------------------
# High-level: render a single volume into an axes
# ---------------------------------------------------------------------------

def render_volume_preview(
    volume: np.ndarray,
    ax,
    *,
    projection: ProjectionMode = "auto",
    axis: int = 0,
    auto_crop: bool = True,
    crop_threshold_sigma: float = 1.0,
    contrast_percentile: Tuple[float, float] = (1.0, 99.5),
    cmap: str = "gray",
    interpolation: str = "bilinear",
    title: Optional[str] = None,
    show_axis: bool = False,
    aspect: Optional[str] = None,
) -> np.ndarray:
    """Render a 2D preview of an MRC volume to a matplotlib axes.

    Returns the displayed 2D array (after projection + cropping). Use
    this in place of the ad-hoc ``mrc.data[mid_z, :, :] + imshow`` code
    in viz endpoints. All knobs are keyword-only so callers can override
    one detail without restating the rest.

    Choosing ``projection``:

    - ``"sum"`` is the right default for **class-average previews**
      (Class3D ``run_it*_class*.mrc``). The molecule is often elongated,
      hollow, or off-centre, and a single slice tangent to it can split
      the density into disconnected lobes. A Z-axis sum integrates the
      whole density column so every voxel contributes — this is what
      RELION's own GUI does.
    - ``"best_slice"`` / ``"auto"`` are better for **refined consensus
      maps** (Refine3D, PostProcess half-maps) where the user wants to
      see the 2D shape of a specific slice.
    - ``"mip"`` shows the maximum value along the projection axis — good
      for visualising local-resolution maps and other "where is the
      signal?" overlays.

    Choosing ``auto_crop``:

    - ``False`` keeps the full box, which is the right behaviour for
      previews that should preserve scale and centring information
      (class averages, refined maps).
    - ``True`` is useful when the box is large relative to the molecule
      (e.g. preliminary class previews where the user doesn't care about
      box size).
    """
    arr = np.asarray(volume, dtype=np.float32)
    image = project_volume(arr, mode=projection, axis=axis)
    if image.ndim != 2:
        # Defensive — caller passed something we can't handle.
        image = np.asarray(image).reshape(arr.shape[-2], arr.shape[-1])

    if auto_crop:
        image = auto_crop_to_density(
            image, threshold_sigma=crop_threshold_sigma, keep_square=True
        )

    vmin, vmax = auto_contrast(image, percentile=contrast_percentile)

    imshow_kwargs = dict(cmap=cmap, vmin=vmin, vmax=vmax, interpolation=interpolation)
    if aspect is not None:
        imshow_kwargs["aspect"] = aspect
    ax.imshow(image, **imshow_kwargs)

    if title is not None:
        ax.set_title(title)
    if not show_axis:
        ax.axis("off")
    return image


def render_three_views(
    volume: np.ndarray,
    axes,
    *,
    contrast_percentile: Tuple[float, float] = (1.0, 99.5),
    cmap: str = "gray",
    titles: Tuple[str, str, str] = ("XY", "XZ", "YZ"),
    auto_crop: bool = True,
) -> None:
    """Render XY / XZ / YZ best-variance slices into three axes.

    For Refine3D / InitialModel / MaskCreate volumes where users expect
    three orthogonal views, this is the equivalent of
    :func:`render_volume_preview` x3 with consistent contrast across the
    three panels.
    """
    arr = np.asarray(volume, dtype=np.float32)
    if arr.ndim != 3:
        return

    views = [
        pick_best_slice(arr, axis=0),  # XY  (slice along Z)
        pick_best_slice(arr, axis=1),  # XZ  (slice along Y)
        pick_best_slice(arr, axis=2),  # YZ  (slice along X)
    ]
    # Compute global contrast across the three views so they're directly comparable.
    combined = np.concatenate([v.ravel() for v in views])
    vmin, vmax = auto_contrast(combined, percentile=contrast_percentile)

    for ax, view, title in zip(axes, views, titles):
        if auto_crop:
            view = auto_crop_to_density(view, keep_square=True)
        ax.imshow(view, cmap=cmap, vmin=vmin, vmax=vmax, interpolation="bilinear")
        ax.set_title(title)
        ax.axis("off")
