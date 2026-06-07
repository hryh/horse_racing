"""
FastAPI backend for HKJC Racing Predictor dashboard.
Deployed on Render.com — loaded once at startup, served hot.
"""
import os
import sys
import importlib.util
from datetime import date, timedelta
from typing import Optional

# ── Package shim ─────────────────────────────────────────────────────────────
# The repo root IS the horse_racing package (it has __init__.py with relative
# imports).  On Render the repo is cloned flat into /opt/render/project/src/
# so there is no 'horse_racing/' sub-directory — we register it manually.
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _REPO_ROOT)

if "horse_racing" not in sys.modules:
    _spec = importlib.util.spec_from_file_location(
        "horse_racing",
        os.path.join(_REPO_ROOT, "__init__.py"),
        submodule_search_locations=[_REPO_ROOT],
    )
    _pkg = importlib.util.module_from_spec(_spec)   # type: ignore[arg-type]
    _pkg.__path__ = [_REPO_ROOT]                     # type: ignore[assignment]
    _pkg.__package__ = "horse_racing"
    sys.modules["horse_racing"] = _pkg
# ─────────────────────────────────────────────────────────────────────────────

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from horse_racing.predictor import HorseRacingPredictor, compute_qpl_bets
from horse_racing.data_fetcher import get_race_card, get_live_qpl_odds

MODELS_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "models"
)

app = FastAPI(title="HKJC Racing Predictor API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],   # lock down to your Vercel URL in production via env var
    allow_methods=["GET"],
    allow_headers=["*"],
)

_predictor: Optional[HorseRacingPredictor] = None


@app.on_event("startup")
async def load_model():
    global _predictor
    try:
        _predictor = HorseRacingPredictor.load(MODELS_DIR)
        print(f"[startup] Model loaded from {MODELS_DIR}")
    except Exception as exc:
        print(f"[startup] WARNING — could not load model: {exc}")


# ---------------------------------------------------------------------------
# Health check
# ---------------------------------------------------------------------------

@app.get("/health")
def health():
    return {"status": "ok", "model_loaded": _predictor is not None}


# ---------------------------------------------------------------------------
# Next meeting detection
# ---------------------------------------------------------------------------

@app.get("/next-meeting")
def next_meeting():
    """Return the nearest upcoming race meeting in the next 14 days."""
    today = date.today()
    for delta in range(0, 15):
        d = today + timedelta(days=delta)
        d_str = d.strftime("%Y-%m-%d")
        for venue in ["ST", "HV"]:
            try:
                card = get_race_card(d_str, venue=venue)
                if card.get("races"):
                    return {
                        "date": d_str,
                        "venue": venue,
                        "race_count": len(card["races"]),
                    }
            except Exception:
                continue
    return {"date": None, "venue": None, "race_count": 0}


# ---------------------------------------------------------------------------
# Predictions
# ---------------------------------------------------------------------------

@app.get("/predict")
def predict(meeting_date: str, venue: str = "ST"):
    """
    Fetch the HKJC race card and return model predictions.

    Query params:
        meeting_date  YYYY-MM-DD
        venue         ST | HV
    """
    if _predictor is None:
        raise HTTPException(status_code=503, detail="Model not loaded - check Render logs")

    try:
        card = get_race_card(meeting_date, venue=venue)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Failed to fetch HKJC card: {exc}")

    if not card.get("races"):
        return {"date": meeting_date, "venue": venue, "races": [],
                "message": "No races found — card may not be published yet"}

    results = _predictor.predict_card(card)

    # Fetch live QPL market odds (available during betting window only)
    live_qpl = get_live_qpl_odds(meeting_date, venue)

    # Build a runner lookup keyed by horse name for each race
    card_by_race = {r["race_no"]: r for r in card["races"]}

    output_races = []
    for result in results:
        rno = result["race_no"]
        card_race = card_by_race.get(rno, {})
        runner_map = {
            ru.get("horse"): ru for ru in card_race.get("runners", [])
        }

        horses = []
        for dec in result["decisions"]:
            ru = runner_map.get(dec.horse_name, {})
            raw_odds = ru.get("win_odds")          # None if not yet published
            horses.append({
                "name":           dec.horse_name,
                "name_ch":        ru.get("horse_ch"),
                "horse_no":       ru.get("horse_no"),
                "draw":           ru.get("draw"),
                "jockey":         ru.get("jockey"),
                "jockey_ch":      ru.get("jockey_ch"),
                "trainer_ch":     ru.get("trainer_ch"),
                "win_prob":       round(dec.win_prob, 4),
                "win_odds":       raw_odds,          # null when unpublished
                "expected_value": round(dec.expected_value, 4) if raw_odds else None,
                "should_bet":     dec.should_bet and raw_odds is not None,
                "bet_fraction":   round(dec.bet_fraction * 100, 2) if raw_odds else None,
            })

        # QPL bets via Harville formula + optional market odds
        qpl_market = live_qpl.get(rno)
        qpl_bets = compute_qpl_bets(
            result["decisions"],
            _predictor.kelly,
            qpl_market_odds=qpl_market,
            top_n=3,
        )

        output_races.append({
            "race_no":     rno,
            "race_class":  card_race.get("class", ""),
            "distance":    card_race.get("distance"),
            "going":       card_race.get("going", ""),
            "course":      card_race.get("course", ""),
            "horses":      horses,
            "best_bet":    result["best_bet"].horse_name if result["best_bet"] else None,
            "qpl_bets":    qpl_bets,
        })

    return {"date": meeting_date, "venue": venue, "races": output_races}
