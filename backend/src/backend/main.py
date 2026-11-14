"""ASGI entry point. The legacy prototype is isolated in backend.legacy_main."""
from backend.runtime.app import app, create_app

__all__ = ["app", "create_app"]
