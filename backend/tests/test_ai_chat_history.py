from types import SimpleNamespace

from app.services.ai_assistant_service import pack_chat_history


def _msg(role, content, facts=""):
    traces = [{"result_summary": facts}] if facts else []
    return SimpleNamespace(role=role, content=content, tool_traces=traces)


def test_short_chat_stays_verbatim():
    messages = [
        _msg("user", "What percent converted?"),
        _msg("assistant", "35 of 291.", "35 of 291 leads"),
    ]
    memory, recent = pack_chat_history(messages)
    assert memory == ""
    assert recent[-1]["content"].startswith("35 of 291.")
    assert "35 of 291 leads" in recent[-1]["content"]


def test_older_turns_become_memory_and_recent_turns_stay():
    messages = []
    for index in range(20):
        messages.append(_msg("user", f"Question {index}"))
        messages.append(_msg("assistant", f"Answer {index}", f"fact {index}"))
    memory, recent = pack_chat_history(messages)
    assert "Question 0" in memory
    assert "fact 0" in memory
    assert recent[0]["content"] == "Question 14"
    assert len(recent) == 12
    assert "fact 19" in recent[-1]["content"]
