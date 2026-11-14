"""Route dependencies backed by application state."""

from fastapi import Request

from backend.legacy_main import CoreServices


def get_core(request: Request) -> CoreServices:
    return request.app.state.core
