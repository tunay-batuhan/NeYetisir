"""tarla agent'ını OpenRouter modeliyle kurar ve context'ten rapor üretir."""

from __future__ import annotations

import json
import time
import uuid
from collections.abc import AsyncIterator
from pathlib import Path

from langchain.agents import create_agent
from langchain_openrouter import ChatOpenRouter

# Birleşik sistem promptu (eski SOUL + rapor SKILL). Düz markdown; düzenlemek için
# uvicorn restart (--reload otomatik). Agent'lar lazy build edildiği için modül
# yüklenişinde bir kez okunur.
SYSTEM_PROMPT = (Path(__file__).resolve().parent.parent / "prompts" / "tarla.md").read_text(
    encoding="utf-8"
)

# Şimdilik tool yok; ileride derinlik_sorgu / gecmis_yil gibi tool'lar buraya eklenebilir.
TOOLS: list = []


class ReportError(RuntimeError):
    pass


def build_tarla_agent(model_name: str, api_key: str):
    if not api_key:
        raise ReportError("OPENROUTER_API_KEY .env'de tanımlı değil.")
    model = ChatOpenRouter(model=model_name, api_key=api_key)
    return create_agent(model=model, tools=TOOLS, system_prompt=SYSTEM_PROMPT)


async def generate_report(agent, context: dict) -> str:
    config = {"configurable": {"thread_id": str(uuid.uuid4())}}
    user_msg = json.dumps(context, ensure_ascii=False, indent=2)
    state = await agent.ainvoke(
        {"messages": [{"role": "user", "content": user_msg}]},
        config,
    )
    for msg in reversed(state.get("messages", [])):
        if msg.type == "ai" and msg.content and not msg.tool_calls:
            return msg.content if isinstance(msg.content, str) else str(msg.content)
    raise ReportError("Agent rapor üretmedi.")


async def stream_report(agent, context: dict) -> AsyncIterator[dict]:
    """Agent'ı astream ile çalıştırır, her node update'i için frontend'e
    gönderilebilir bir event dict'i yield eder.

    Event tipleri:
      - {"tip":"tool_call", "ad":<name>, "args":{...}}
      - {"tip":"tool_result", "ad":<name>, "ozet":<str>}
      - {"tip":"rapor", "icerik":<markdown>}
      - {"tip":"ozet", ...}    turn özeti (LLM call sayısı/token/süre/tps)
    """
    user_msg = json.dumps(context, ensure_ascii=False, indent=2)
    messages = [{"role": "user", "content": user_msg}]
    async for ev in _stream_messages(agent, messages, icerik_tipi="rapor"):
        yield ev


async def stream_chat(
    agent,
    context: dict,
    rapor: str,
    gecmis: list[dict],
    mesaj: str,
) -> AsyncIterator[dict]:
    """Sohbet modu: rapor zaten oluşturulmuş, kullanıcı takip sorusu soruyor.

    Mesaj listesi: [user(context-json), assistant(rapor), *gecmis, user(mesaj)].
    Event tipleri stream_report ile aynı; final cevap için "rapor" yerine "yanit".
    """
    ctx_json = json.dumps(context, ensure_ascii=False, indent=2)
    messages: list[dict] = [
        {"role": "user", "content": ctx_json},
        {"role": "assistant", "content": rapor},
        {
            "role": "user",
            "content": (
                "[Sistem bildirimi] Rapor tamamlandı, sohbet moduna geçildi. "
                "Bundan sonraki mesajlarım rapor ve yukarıdaki veri üzerine takip soruları olacak. "
                "Raporu tekrar üretme; sorulara kısa ve doğrudan cevap ver."
            ),
        },
        {
            "role": "assistant",
            "content": "Anlaşıldı, sohbet modundayım. Rapor ve veriler hafızamda; sorularını dinliyorum.",
        },
    ]
    role_map = {"user": "user", "assistant": "assistant"}
    for m in gecmis:
        rol = role_map.get(m.get("rol"), "user")
        icerik = m.get("icerik") or ""
        if icerik:
            messages.append({"role": rol, "content": icerik})
    messages.append({"role": "user", "content": mesaj})

    async for ev in _stream_messages(agent, messages, icerik_tipi="yanit"):
        yield ev


async def _stream_messages(
    agent,
    messages: list[dict],
    *,
    icerik_tipi: str,
) -> AsyncIterator[dict]:
    config = {"configurable": {"thread_id": str(uuid.uuid4())}}

    t0 = time.perf_counter()
    cevap_var = False
    llm_calls = 0
    in_tok = 0
    out_tok = 0
    tools_used: list[str] = []

    async for event in agent.astream(
        {"messages": messages},
        config,
        stream_mode="updates",
    ):
        for payload in event.values():
            for msg in payload.get("messages", []) or []:
                if msg.type == "ai":
                    llm_calls += 1
                    um = getattr(msg, "usage_metadata", None) or {}
                    in_tok += um.get("input_tokens", 0)
                    out_tok += um.get("output_tokens", 0)
                    for tc in msg.tool_calls or []:
                        tools_used.append(tc["name"])
                        yield {"tip": "tool_call", "ad": tc["name"], "args": tc.get("args") or {}}
                    if msg.content and not msg.tool_calls:
                        icerik = msg.content if isinstance(msg.content, str) else str(msg.content)
                        cevap_var = True
                        yield {"tip": icerik_tipi, "icerik": icerik}
                elif msg.type == "tool":
                    raw = str(msg.content).replace("\n", " ")
                    ozet = raw if len(raw) <= 100 else raw[:97] + "..."
                    yield {"tip": "tool_result", "ad": msg.name, "ozet": ozet}

    if not cevap_var:
        raise ReportError("Agent cevap üretmedi.")

    sure_ms = int((time.perf_counter() - t0) * 1000)
    tps = round(out_tok / (sure_ms / 1000), 1) if sure_ms > 0 else 0.0
    yield {
        "tip": "ozet",
        "llm_call_sayisi": llm_calls,
        "sure_ms": sure_ms,
        "input_tokens": in_tok,
        "output_tokens": out_tok,
        "tps": tps,
        "tools": sorted(set(tools_used)),
    }
