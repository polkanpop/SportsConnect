import hashlib
import json
import os
import time
from typing import Any, Dict, Optional

from urllib.parse import urlencode
from urllib.request import Request, urlopen
from urllib.error import HTTPError

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from ..auth import get_current_user
from ..db import rest_update

router = APIRouter(prefix="/cloudinary", tags=["cloudinary"])


def _require_env(name: str) -> str:
    v = os.getenv(name)
    if not v:
        raise HTTPException(status_code=500, detail=f"Missing env var: {name}")
    return v


def _cloudinary_signature(params: Dict[str, Any], api_secret: str) -> str:
    """Create Cloudinary API signature for signed uploads.

    Cloudinary signature algorithm: SHA1 of a query-string of parameters sorted
    by key, joined with '&', with api_secret appended.

    Notes:
    - Exclude file/api_key/signature from signature.
    - Values must be strings; booleans should be 'true'/'false'.
    """
    filtered: Dict[str, str] = {}
    for k, v in params.items():
        if v is None or v == "":
            continue
        if k in {"file", "api_key", "signature"}:
            continue
        if isinstance(v, bool):
            filtered[k] = "true" if v else "false"
        else:
            filtered[k] = str(v)

    to_sign = "&".join(f"{k}={filtered[k]}" for k in sorted(filtered))
    raw = (to_sign + api_secret).encode("utf-8")
    return hashlib.sha1(raw).hexdigest()


class CloudinaryConfigResponse(BaseModel):
    cloudName: str
    apiKey: str
    uploadPreset: Optional[str] = None
    folder: Optional[str] = None


@router.get("/config", response_model=CloudinaryConfigResponse)
def get_config(_: str = Depends(get_current_user)):
    """Return non-secret Cloudinary config for the client.

    This endpoint is auth-protected to reduce abuse, but the returned fields are
    not secrets.
    """
    cloud_name = _require_env("CLOUDINARY_CLOUD_NAME")
    api_key = _require_env("CLOUDINARY_API_KEY")
    upload_preset = os.getenv("CLOUDINARY_UPLOAD_PRESET")
    folder = os.getenv("CLOUDINARY_FOLDER")
    return CloudinaryConfigResponse(
        cloudName=cloud_name,
        apiKey=api_key,
        uploadPreset=upload_preset,
        folder=folder,
    )


class SignUploadRequest(BaseModel):
    """Parameters the client will send to Cloudinary.

    We sign the provided parameters + a server-generated timestamp.

    Typical client upload parameters:
    - upload_preset
    - folder
    - public_id (optional)
    - overwrite (optional)
    """

    upload_preset: Optional[str] = Field(default=None)
    folder: Optional[str] = Field(default=None)
    public_id: Optional[str] = Field(default=None)
    overwrite: Optional[bool] = Field(default=None)
    invalidate: Optional[bool] = Field(default=None)
    tags: Optional[str] = Field(default=None)
    context: Optional[str] = Field(default=None)
    transformation: Optional[str] = Field(default=None)


class SignUploadResponse(BaseModel):
    cloudName: str
    apiKey: str
    timestamp: int
    signature: str
    uploadPreset: Optional[str] = None
    folder: Optional[str] = None


@router.post("/sign", response_model=SignUploadResponse)
def sign_upload(req: SignUploadRequest, _: str = Depends(get_current_user)):
    """Return a Cloudinary signature for a signed direct upload from the client."""
    cloud_name = _require_env("CLOUDINARY_CLOUD_NAME")
    api_key = _require_env("CLOUDINARY_API_KEY")
    api_secret = _require_env("CLOUDINARY_API_SECRET")

    timestamp = int(time.time())

    upload_preset = req.upload_preset or os.getenv("CLOUDINARY_UPLOAD_PRESET")
    folder = req.folder or os.getenv("CLOUDINARY_FOLDER")

    params: Dict[str, Any] = req.model_dump(exclude_none=True)
    if upload_preset:
        params["upload_preset"] = upload_preset
    if folder:
        params["folder"] = folder
    params["timestamp"] = timestamp

    signature = _cloudinary_signature(params, api_secret)

    return SignUploadResponse(
        cloudName=cloud_name,
        apiKey=api_key,
        timestamp=timestamp,
        signature=signature,
        uploadPreset=upload_preset,
        folder=folder,
    )


class DeletePfpResponse(BaseModel):
    cloudinaryResult: str
    pfpCleared: bool
    publicIdUsed: Optional[str] = None
    attemptedPublicIds: Optional[list[str]] = None


@router.post("/pfp/delete", response_model=DeletePfpResponse)
def delete_profile_picture(sub: str = Depends(get_current_user)):
    """Delete the authenticated user's profile picture from Cloudinary and clear userinfo.pfp.

    Security:
    - Requires Bearer token
    - Uses token subject as userid; cannot delete other users' assets.
    """
    try:
        userid = int(str(sub))
    except Exception:
        raise HTTPException(status_code=403, detail="Token subject is not a numeric userid")

    cloud_name = _require_env("CLOUDINARY_CLOUD_NAME")
    api_key = _require_env("CLOUDINARY_API_KEY")
    api_secret = _require_env("CLOUDINARY_API_SECRET")

    base_public_id = f"pfp_user_{userid}"
    folder = os.getenv("CLOUDINARY_FOLDER")
    folder = folder.strip().strip("/") if isinstance(folder, str) else ""
    candidates: list[str] = []
    if folder:
        candidates.append(f"{folder}/{base_public_id}")
    candidates.append(base_public_id)
    # De-dup while preserving order
    seen: set[str] = set()
    public_ids: list[str] = []
    for pid in candidates:
        if pid in seen:
            continue
        seen.add(pid)
        public_ids.append(pid)

    url = f"https://api.cloudinary.com/v1_1/{cloud_name}/image/destroy"

    def _destroy(public_id: str) -> str:
        timestamp = int(time.time())
        destroy_params: Dict[str, Any] = {
            "public_id": public_id,
            "timestamp": timestamp,
            "invalidate": True,
            "type": "upload",
        }
        signature = _cloudinary_signature(destroy_params, api_secret)
        payload = {
            "public_id": public_id,
            "timestamp": str(timestamp),
            "invalidate": "true",
            "type": "upload",
            "api_key": api_key,
            "signature": signature,
        }
        body = urlencode(payload).encode("utf-8")
        req = Request(url, data=body, method="POST")
        req.add_header("Content-Type", "application/x-www-form-urlencoded")
        with urlopen(req, timeout=20) as resp:
            raw = resp.read().decode("utf-8")
        data = json.loads(raw) if raw else {}
        return str((data or {}).get("result") or "ok")

    cloud_result = "unknown"
    public_id_used: Optional[str] = None
    try:
        for pid in public_ids:
            try:
                r = _destroy(pid)
                cloud_result = r
                if r == "ok":
                    public_id_used = pid
                    break
                # If not found, try next candidate (common when folder is involved)
                if r == "not found":
                    continue
                # Any other result: stop and report it
                public_id_used = pid
                break
            except HTTPError as e:
                # On HTTP error, surface the first meaningful Cloudinary error message.
                try:
                    raw = e.read().decode("utf-8")
                    data = json.loads(raw) if raw else {}
                    msg = (data or {}).get("error", {}).get("message") or f"Cloudinary destroy failed (HTTP {e.code})"
                except Exception:
                    msg = f"Cloudinary destroy failed (HTTP {getattr(e, 'code', 'unknown')})"
                raise HTTPException(status_code=502, detail=msg)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(getattr(e, "message", None) or str(e)))

    pfp_cleared = False
    try:
        updated = rest_update("userinfo", {"userid": userid}, {"pfp": None})
        pfp_cleared = bool(updated)
    except Exception:
        # If DB update fails, report partial failure.
        pfp_cleared = False

    return DeletePfpResponse(
        cloudinaryResult=cloud_result,
        pfpCleared=pfp_cleared,
        publicIdUsed=public_id_used,
        attemptedPublicIds=public_ids,
    )
