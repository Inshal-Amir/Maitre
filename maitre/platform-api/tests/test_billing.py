from app.billing import input_token_upper_bound
from app.config import get_settings

IMAGE = "data:image/png;base64," + "A" * 400_000


def _body(content):
    return {"messages": [{"role": "user", "content": content}]}


def test_image_counts_as_fixed_budget_not_base64_bytes():
    s = get_settings()
    text_only = input_token_upper_bound(_body([{"type": "text", "text": "what is this?"}]), 1_048_576)
    with_image = input_token_upper_bound(
        _body([{"type": "text", "text": "what is this?"}, {"type": "image_url", "image_url": {"url": IMAGE}}]), 1_048_576)
    assert with_image - text_only == s.image_token_upper_bound


def test_plain_string_content_unchanged():
    body = _body("hello")
    assert input_token_upper_bound(body, 1_048_576) < 2000
    assert input_token_upper_bound(body, 100) == 100
