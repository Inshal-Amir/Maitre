"""Playground image turns: validation and the message parts sent upstream (unit level, no live API needed)."""

from __future__ import annotations

import base64

import pytest

from app.errors import ApiError
from app.routes_platform import (
    PLAYGROUND_MAX_IMAGE_BYTES,
    MessageCreate,
    saved_turn_text,
    user_turn_content,
    validate_turn,
)

PNG = "data:image/png;base64," + base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"0" * 64).decode()


def code_of(body: MessageCreate) -> str:
    with pytest.raises(ApiError) as caught:
        validate_turn(body)
    assert caught.value.status == 400
    return caught.value.code


def test_text_only_turn_is_unchanged():
    body = MessageCreate(content="hello")
    validate_turn(body)
    assert user_turn_content(body) == "hello" and saved_turn_text(body) == "hello"


def test_image_turn_builds_parts_and_saves_a_marker():
    body = MessageCreate(content="what is this?", images=[PNG, PNG])
    validate_turn(body)
    assert user_turn_content(body) == [
        {"type": "text", "text": "what is this?"},
        {"type": "image_url", "image_url": {"url": PNG}},
        {"type": "image_url", "image_url": {"url": PNG}},
    ]
    assert saved_turn_text(body) == "what is this?\n\n[2 images attached]"


def test_image_only_turn_is_allowed():
    body = MessageCreate(images=[PNG])
    validate_turn(body)
    assert user_turn_content(body) == [{"type": "image_url", "image_url": {"url": PNG}}]
    assert saved_turn_text(body) == "[1 image attached]"


def test_empty_turn_rejected():
    assert code_of(MessageCreate(content="  ")) == "empty_message"


@pytest.mark.parametrize("url", [
    "data:image/svg+xml;base64,PHN2Zz4=",
    "data:text/plain;base64,aGVsbG8=",
    "https://example.com/cat.png",
    "data:image/png;base64,not*base64",
])
def test_bad_image_rejected(url):
    assert code_of(MessageCreate(content="x", images=[url])) == "invalid_image"


def test_too_large_image_rejected():
    big = "data:image/jpeg;base64," + base64.b64encode(b"0" * (PLAYGROUND_MAX_IMAGE_BYTES + 1)).decode()
    assert code_of(MessageCreate(content="x", images=[big])) == "image_too_large"


def test_too_many_images_rejected():
    from pydantic import ValidationError

    with pytest.raises(ValidationError):
        MessageCreate(content="x", images=[PNG] * 5)
