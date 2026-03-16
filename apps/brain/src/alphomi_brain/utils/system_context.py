from __future__ import annotations

import asyncio
import os
import platform
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional

import httpx


@dataclass
class _IpInfo:
    ip: str
    country: Optional[str] = None
    region: Optional[str] = None
    city: Optional[str] = None
    timezone: Optional[str] = None
    isp: Optional[str] = None
    org: Optional[str] = None
    lat: Optional[float] = None
    lon: Optional[float] = None


_CACHE_LOCK = asyncio.Lock()
_CACHED_TEXT: Optional[str] = None
_CACHED_AT: Optional[datetime] = None
_CACHE_TTL_SECONDS = int(os.getenv("SYSTEM_CONTEXT_TTL_SECONDS", "300"))


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _env_proxy() -> Optional[str]:
    return (
        os.getenv("HTTPS_PROXY")
        or os.getenv("https_proxy")
        or os.getenv("HTTP_PROXY")
        or os.getenv("http_proxy")
    )


async def _fetch_public_ip(trust_env: bool) -> Optional[str]:
    try:
        timeout = httpx.Timeout(3.0, connect=2.0)
        async with httpx.AsyncClient(timeout=timeout, trust_env=trust_env) as client:
            resp = await client.get("https://api.ipify.org?format=json")
            resp.raise_for_status()
            data = resp.json()
            ip = data.get("ip")
            return ip if isinstance(ip, str) and ip else None
    except Exception:
        return None


async def _fetch_ip_info(ip: str) -> _IpInfo:
    if not ip:
        return _IpInfo(ip="unknown")
    try:
        timeout = httpx.Timeout(3.0, connect=2.0)
        async with httpx.AsyncClient(timeout=timeout, trust_env=False) as client:
            url = (
                "http://ip-api.com/json/"
                f"{ip}?fields=status,country,regionName,city,timezone,isp,org,lat,lon,query"
            )
            resp = await client.get(url)
            resp.raise_for_status()
            data = resp.json()
            if data.get("status") != "success":
                return _IpInfo(ip=ip)
            return _IpInfo(
                ip=data.get("query") or ip,
                country=data.get("country"),
                region=data.get("regionName"),
                city=data.get("city"),
                timezone=data.get("timezone"),
                isp=data.get("isp"),
                org=data.get("org"),
                lat=data.get("lat"),
                lon=data.get("lon"),
            )
    except Exception:
        return _IpInfo(ip=ip)


def _format_ip_info(label: str, info: _IpInfo) -> str:
    parts = [f"{label}: {info.ip or 'unknown'}"]
    loc_parts = [p for p in [info.country, info.region, info.city] if p]
    if loc_parts:
        parts.append(f"Location: {', '.join(loc_parts)}")
    if info.timezone:
        parts.append(f"Timezone: {info.timezone}")
    if info.isp:
        parts.append(f"ISP: {info.isp}")
    if info.org:
        parts.append(f"Org: {info.org}")
    if info.lat is not None and info.lon is not None:
        parts.append(f"Lat/Lon: {info.lat}, {info.lon}")
    return " | ".join(parts)


async def get_system_context_summary() -> str:
    global _CACHED_TEXT, _CACHED_AT

    async with _CACHE_LOCK:
        now = _now_utc()
        if _CACHED_TEXT and _CACHED_AT:
            if (now - _CACHED_AT).total_seconds() < _CACHE_TTL_SECONDS:
                return _CACHED_TEXT

        app_version = (
            os.getenv("BRAIN_VERSION")
            or os.getenv("APP_VERSION")
            or os.getenv("VERSION")
            or "unknown"
        )
        os_version = platform.platform()
        python_version = platform.python_version()
        local_time = datetime.now().isoformat(timespec="seconds")
        utc_time = now.isoformat(timespec="seconds")

        proxy_env = _env_proxy()
        direct_ip = await _fetch_public_ip(trust_env=False)
        proxy_ip = None
        if proxy_env:
            proxy_ip = await _fetch_public_ip(trust_env=True)

        direct_info = await _fetch_ip_info(direct_ip or "unknown")
        proxy_info = None
        if proxy_ip and proxy_ip != direct_info.ip:
            proxy_info = await _fetch_ip_info(proxy_ip)

        lines = [
            "# Runtime Context",
            f"App Version: {app_version}",
            f"OS: {os_version}",
            f"Python: {python_version}",
            f"Local Time: {local_time}",
            f"UTC Time: {utc_time}",
        ]

        lines.append(_format_ip_info("Direct IP", direct_info))
        if proxy_env:
            lines.append(f"Proxy: {proxy_env}")
            if proxy_info:
                lines.append(_format_ip_info("Proxy IP", proxy_info))
            elif proxy_ip:
                lines.append(f"Proxy IP: {proxy_ip}")

        _CACHED_TEXT = "\n".join(lines)
        _CACHED_AT = now
        return _CACHED_TEXT
