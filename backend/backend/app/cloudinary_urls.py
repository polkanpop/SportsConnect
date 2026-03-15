from __future__ import annotations

import re
from typing import Iterable


_CLOUDINARY_MARKER = "/image/upload/"
_CLOUDINARY_TRANSFORM_PREFIX_RE = re.compile(r"^(?:[a-z]{1,3}_[^/]+)(?:,[a-z]{1,3}_[^/]+)*$")


def is_cloudinary_upload_url(url: str) -> bool:
    return isinstance(url, str) and _CLOUDINARY_MARKER in url


def apply_cloudinary_transform(url: str, *, width: int) -> str:
    """Apply standardized Cloudinary delivery transform.

    Resulting transform is always: f_auto,q_auto,w_<width>.
    Existing transform segments are replaced to keep output deterministic.
    """
    if not isinstance(url, str):
        return url

    raw = url.strip()
    if not raw or _CLOUDINARY_MARKER not in raw:
        return raw

    base, query = (raw.split("?", 1) + [""])[:2]
    idx = base.find(_CLOUDINARY_MARKER)
    if idx < 0:
        return raw

    before = base[: idx + len(_CLOUDINARY_MARKER)]
    after = base[idx + len(_CLOUDINARY_MARKER) :]
    segments = [s for s in after.split("/") if s]
    if not segments:
        return raw

    transform = f"f_auto,q_auto,w_{max(16, min(int(width), 4096))}"

    # If first segment is an existing transformation, preserve crop/gravity
    # directives and only standardize format/quality/width.
    if _CLOUDINARY_TRANSFORM_PREFIX_RE.match(segments[0]):
        existing = [part.strip() for part in segments[0].split(",") if part.strip()]
        keep = [part for part in existing if not part.startswith(("f_", "q_", "w_"))]
        wanted = [part.strip() for part in transform.split(",") if part.strip()]
        segments[0] = ",".join([*keep, *wanted])
    else:
        segments.insert(0, transform)

    rebuilt = before + "/".join(segments)
    if query:
        rebuilt = f"{rebuilt}?{query}"
    return rebuilt


def apply_cloudinary_transform_list(images: Iterable[str] | None, *, width: int) -> list[str]:
    if not images:
        return []
    out: list[str] = []
    for image in images:
        if isinstance(image, str) and image.strip():
            out.append(apply_cloudinary_transform(image, width=width))
    return out
