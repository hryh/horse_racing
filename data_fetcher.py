"""
HKJC Data Fetcher
-----------------
Fetches live and historical race data via the HKJC GraphQL API.
Uses the same endpoint as the hkjc-api npm package:
  https://info.cld.hkjc.com/graphql/base/
"""
import json
import time
import requests
import pandas as pd
from datetime import datetime, date
from typing import Optional


# ---------------------------------------------------------------------------
# GraphQL endpoint
# ---------------------------------------------------------------------------
GRAPHQL_URL = "https://info.cld.hkjc.com/graphql/base/"

HEADERS = {
    "Content-Type": "application/json",
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Origin": "https://bet.hkjc.com",
    "Referer": "https://bet.hkjc.com/",
}

# Query extracted from bet.hkjc.com frontend bundle (main.27c3f033.js)
_RACE_MEETINGS_QUERY = """
fragment raceFragment on Race {
    id
    no
    status
    raceName_en
    raceName_ch
    postTime
    country_en
    country_ch
    distance
    wageringFieldSize
    go_en
    go_ch
    ratingType
    raceTrack {
      description_en
      description_ch
    }
    raceCourse {
      description_en
      description_ch
      displayCode
    }
    claCode
    raceClass_en
    raceClass_ch
    judgeSigns {
      value_en
    }
  }

fragment racingBlockFragment on RaceMeeting {
    jpEsts: pmPools(oddsTypes: [WIN,PLA,TCE,TRI,FF,QTT,DT,TT,SixUP], filters: ["jackpot", "estimatedDividend"]) {
      leg { number races }
      oddsType jackpot estimatedDividend mergedPoolId
    }
    poolInvs: pmPools(oddsTypes: [WIN,PLA,QIN,QPL,CWA,CWB,CWC,IWN,FCT,TCE,TRI,FF,QTT,DBL,TBL,DT,TT,SixUP]) {
      id
      leg { races }
    }
    penetrometerReadings(filters:["first"]) { reading readingTime }
    hammerReadings(filters:["first"]) { reading readingTime }
    changeHistories(filters:["top3"]) {
      type time raceNo runnerNo
      horseName_ch horseName_en
      jockeyName_ch jockeyName_en
      scratchHorseName_ch scratchHorseName_en
      handicapWeight scrResvIndicator
    }
  }

query raceMeetings($date: String, $venueCode: String) {
            timeOffset {
              rc
            }
            activeMeetings : raceMeetings
            {
              id
              venueCode
              date
              status
              races {
                no
                postTime
                status
                wageringFieldSize
              }
            }
            raceMeetings(date: $date, venueCode: $venueCode)
            {
              id
              status
              venueCode
              date
              totalNumberOfRace
              currentNumberOfRace
              dateOfWeek
              meetingType
              totalInvestment
              country {
                code
                namech
                nameen
                seq
              }
              races {
                ...raceFragment
                runners {
                    id
                    no
                    standbyNo
                    status
                    name_ch
                    name_en
                    horse {
                      id
                      code
                    }
                    color
                    barrierDrawNumber
                    handicapWeight
                    currentWeight
                    currentRating
                    internationalRating
                    gearInfo
                    racingColorFileName
                    allowance
                    trainerPreference
                    last6run
                    saddleClothNo
                    trumpCard
                    priority
                    finalPosition
                    deadHeat
                    winOdds
                    jockey {
                      code
                      name_en
                      name_ch
                    }
                    trainer {
                      code
                      name_en
                      name_ch
                    }
                }
              }
              obSt: pmPools(oddsTypes: [WIN, PLA]) {
                leg { races }
                oddsType
                comingleStatus
              }
              poolInvs: pmPools(oddsTypes: [WIN,PLA,QIN,QPL,CWA,CWB,CWC,IWN,FCT,TCE,TRI,FF,QTT,DBL,TBL,DT,TT,SixUP]) {
                id
                leg { number races }
                status
                sellStatus
                oddsType
                investment
                mergedPoolId
                lastUpdateTime
              }
              ...racingBlockFragment
              pmPools(oddsTypes: []) {
                id
              }
              jkcInstNo : foPools(oddsTypes: [JKC], filters: ["top"]) {
                instNo
              }
              tncInstNo : foPools(oddsTypes: [TNC], filters: ["top"]) {
                instNo
              }
            }
        }
"""

RACE_DATE_FMT = "%Y-%m-%d"

# Live WIN-odds query extracted from bet.hkjc.com bundle (main.1dd5c98e.js)
# Omitting raceNo returns all races in one call.
_LIVE_ODDS_QUERY = """
      query racing($date: String, $venueCode: String, $oddsTypes: [OddsType], $raceNo: Int) {
          raceMeetings(date: $date, venueCode: $venueCode)
          {
            pmPools(oddsTypes: $oddsTypes, raceNo: $raceNo) {
              id
              status
              sellStatus
              oddsType
              lastUpdateTime
              guarantee
              minTicketCost
              name_en
              name_ch
              leg {
                number
                races
              }
              cWinSelections {
                composite
                name_ch
                name_en
                starters
              }
              oddsNodes {
                combString
                oddsValue
                hotFavourite
                oddsDropValue
                bankerOdds {
                  combString
                  oddsValue
                }
              }
            }
          }
      }
"""


# ---------------------------------------------------------------------------
# GraphQL helper
# ---------------------------------------------------------------------------

def _gql(query: str, variables: Optional[dict] = None) -> dict:
    body = {"query": query}
    if variables:
        body["variables"] = variables
    resp = requests.post(GRAPHQL_URL, json=body, headers=HEADERS, timeout=20)
    resp.raise_for_status()
    data = resp.json()
    if "errors" in data and data.get("data") is None:
        raise RuntimeError(f"GraphQL errors: {data['errors']}")
    return data.get("data") or {}


# ---------------------------------------------------------------------------
# Live API helpers
# ---------------------------------------------------------------------------

def _fetch_pool_odds(race_date: str, venue: str, odds_types: list) -> list:
    """
    Call the whitelisted 'racing' query and return pmPools list.
    Returns [] on any error (whitelist block, timeout, etc.).
    """
    try:
        resp = requests.post(
            GRAPHQL_URL,
            json={
                "query": _LIVE_ODDS_QUERY,
                "variables": {"date": race_date, "venueCode": venue, "oddsTypes": odds_types},
            },
            headers=HEADERS,
            timeout=15,
        )
        resp.raise_for_status()
        data = resp.json()
        if data.get("errors"):
            return []
        meetings = (data.get("data") or {}).get("raceMeetings") or []
        return (meetings[0].get("pmPools") or []) if meetings else []
    except Exception:
        return []


def get_live_win_odds(race_date: str, venue: str) -> dict:
    """
    Fetch live WIN pool odds for all races.
    Returns: {race_no (int): {runner_no (int): odds (float)}}
    """
    pools = _fetch_pool_odds(race_date, venue, ["WIN"])
    result: dict = {}
    for pool in pools:
        if pool.get("oddsType") != "WIN":
            continue
        race_no_list = (pool.get("leg") or {}).get("races") or []
        if not race_no_list:
            continue
        race_no = int(race_no_list[0])
        runner_odds: dict = {}
        for node in (pool.get("oddsNodes") or []):
            try:
                rno = int(node["combString"])
                val = _safe_float(node.get("oddsValue"))
                if val and val > 0:
                    runner_odds[rno] = val
            except (TypeError, ValueError, KeyError):
                continue
        result[race_no] = runner_odds
    return result


def get_live_qpl_odds(race_date: str, venue: str) -> dict:
    """
    Fetch live QPL pool odds for all races.
    Returns: {race_no (int): {(a, b) (tuple[int,int]): odds (float)}}
    where a < b are runner numbers.
    Returns empty dict if QPL is not yet available (pre-betting, whitelist block).
    """
    pools = _fetch_pool_odds(race_date, venue, ["QPL"])
    result: dict = {}
    for pool in pools:
        if pool.get("oddsType") != "QPL":
            continue
        race_no_list = (pool.get("leg") or {}).get("races") or []
        if not race_no_list:
            continue
        race_no = int(race_no_list[0])
        pair_odds: dict = {}
        for node in (pool.get("oddsNodes") or []):
            try:
                parts = [int(x) for x in node["combString"].split(",")]
                if len(parts) != 2:
                    continue
                a, b = sorted(parts)
                val = _safe_float(node.get("oddsValue"))
                if val and val > 0:
                    pair_odds[(a, b)] = val
            except (TypeError, ValueError, KeyError):
                continue
        result[race_no] = pair_odds
    return result


def get_race_card(race_date: Optional[str] = None, venue: str = "HV") -> dict:
    """
    Fetch the full race card (runners + current odds) for a given date/venue.

    Returns dict:
        {date, venue, races: [{race_no, class, distance, going, course,
                               runners: [{horse, jockey, trainer, draw,
                                          declar_wt, act_wt, win_odds}]}]}
    """
    if race_date is None:
        race_date = date.today().strftime(RACE_DATE_FMT)

    data = _gql(_RACE_MEETINGS_QUERY, {"date": race_date, "venueCode": venue})
    meetings = data.get("raceMeetings") or []
    if not meetings:
        return {"date": race_date, "venue": venue, "races": []}

    card = _parse_meeting(meetings[0], race_date, venue)

    # Overlay live WIN odds (separate 'racing' query — populated during betting)
    live_odds = get_live_win_odds(race_date, venue)
    if live_odds:
        for race in card["races"]:
            race_no = race.get("race_no")
            runner_odds = live_odds.get(race_no) or {}
            for runner in race.get("runners", []):
                horse_no = runner.get("horse_no")
                try:
                    rno = int(horse_no)
                except (TypeError, ValueError):
                    continue
                live = runner_odds.get(rno)
                if live:
                    runner["win_odds"] = live

    return card


def get_results(race_date: str, venue: str = "HV") -> pd.DataFrame:
    """
    Fetch official results for a completed race day.
    Returns DataFrame (one row per runner) with 'won' column derived from finalPosition.
    """
    data = _gql(_RACE_MEETINGS_QUERY, {"date": race_date, "venueCode": venue})
    meetings = data.get("raceMeetings") or []
    if not meetings:
        return pd.DataFrame()
    return _meeting_to_df(meetings[0], race_date, venue)


def get_active_meetings() -> list:
    """Return list of currently active meeting dicts {venueCode, date}."""
    data = _gql(_RACE_MEETINGS_QUERY, {})
    return data.get("activeMeetings") or []


# ---------------------------------------------------------------------------
# Internal parsers
# ---------------------------------------------------------------------------

def _parse_meeting(meeting: dict, race_date: str, venue: str) -> dict:
    """Convert a raceMeetings GraphQL node to our internal card format."""
    races = []
    for race in meeting.get("races", []):
        runners = []
        for r in race.get("runners", []):
            runners.append({
                "horse_no":   r.get("no"),
                "horse":      r.get("name_en"),
                "horse_ch":   r.get("name_ch"),
                "horse_id":   (r.get("horse") or {}).get("code"),
                "jockey":     (r.get("jockey") or {}).get("code"),
                "jockey_ch":  (r.get("jockey") or {}).get("name_ch"),
                "trainer":    (r.get("trainer") or {}).get("code"),
                "trainer_ch": (r.get("trainer") or {}).get("name_ch"),
                "draw":       _safe_int(r.get("barrierDrawNumber")),
                "declar_wt":  _safe_float(r.get("handicapWeight")),
                "act_wt":     _safe_float(r.get("currentWeight")),
                "win_odds":   _safe_float(r.get("winOdds")),
            })
        races.append({
            "race_no":  race.get("no"),
            "class":    race.get("raceClass_en", ""),
            "distance": _safe_int(race.get("distance")),
            "going":    race.get("go_en", ""),
            "course":   (race.get("raceCourse") or {}).get("displayCode", ""),
            "pool":     None,
            "runners":  runners,
        })
    return {"date": race_date, "venue": venue, "races": races}


def _meeting_to_df(meeting: dict, race_date: str, venue: str) -> pd.DataFrame:
    """Flatten a GraphQL meeting node into a results DataFrame."""
    rows = []
    for race in meeting.get("races", []):
        race_no  = race.get("no")
        class_   = race.get("raceClass_en", "")
        dist     = _safe_int(race.get("distance"))
        going    = race.get("go_en", "")
        course   = (race.get("raceCourse") or {}).get("displayCode", "")

        for r in race.get("runners", []):
            rows.append({
                "date":      race_date,
                "location":  venue,
                "race_no":   race_no,
                "class":     class_,
                "distance":  dist,
                "going":     going,
                "course":    course,
                "pool":      None,
                "place":     _safe_int(r.get("finalPosition")),
                "horse":     r.get("name_en"),
                "horse_id":  (r.get("horse") or {}).get("code"),
                "jockey":    (r.get("jockey") or {}).get("code"),
                "trainer":   (r.get("trainer") or {}).get("code"),
                "act_wt":    _safe_float(r.get("currentWeight")),
                "declar_wt": _safe_float(r.get("handicapWeight")),
                "draw":      _safe_int(r.get("barrierDrawNumber")),
                "lbw":       None,   # not exposed by the API
                "time":      None,   # not exposed by the API
                "win_odds":  _safe_float(r.get("winOdds")),
            })
    df = pd.DataFrame(rows)
    if "place" in df.columns:
        df["won"] = (pd.to_numeric(df["place"], errors="coerce") == 1).astype(int)
    return df


# ---------------------------------------------------------------------------
# CSV / historical data loader
# ---------------------------------------------------------------------------

REQUIRED_COLS = [
    "date", "location", "race_no", "class", "distance", "going", "course",
    "pool", "place", "horse_id", "horse", "jockey", "trainer",
    "act_wt", "declar_wt", "draw", "lbw", "time", "win_odds",
]

OPTIONAL_COLS = ["age", "finish_pos"]


def load_historical_csv(path: str) -> pd.DataFrame:
    """
    Load a historical CSV (produced by build_dataset.py or a third-party scrape).
    Flexible column aliasing handles different naming conventions.
    """
    df = pd.read_csv(path, low_memory=False)
    df.columns = [c.strip().lower().replace(" ", "_") for c in df.columns]

    aliases = {
        "actual_weight":     "act_wt",
        "declare_weight":    "declar_wt",
        "declared_weight":   "declar_wt",
        "race_number":       "race_no",
        "win_odd":           "win_odds",
        "finishing_time":    "time",
        "finish_time":       "time",
        "horse_name":        "horse",
        "jockey_name":       "jockey",
        "trainer_name":      "trainer",
        "position":          "place",
        "finish_position":   "place",
        "finishing_position":"place",
        "venue":             "location",
        "racecourse":        "location",
        "barrier":           "draw",
        "barrier_draw":      "draw",
        "going_condition":   "going",
    }
    df.rename(columns={k: v for k, v in aliases.items() if k in df.columns},
              inplace=True)

    df = _cast_types(df)
    df = df.sort_values(["date", "location", "race_no", "draw"]).reset_index(drop=True)
    return df


# ---------------------------------------------------------------------------
# Type casting
# ---------------------------------------------------------------------------

def _cast_types(df: pd.DataFrame) -> pd.DataFrame:
    if "date" in df.columns:
        df["date"] = pd.to_datetime(df["date"], errors="coerce")
    for col in ["place", "race_no", "draw", "age"]:
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors="coerce")
    for col in ["act_wt", "declar_wt", "win_odds", "pool", "lbw"]:
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors="coerce")
    if "place" in df.columns and "won" not in df.columns:
        df["won"] = (df["place"] == 1).astype(int)
    return df


def _safe_int(v) -> Optional[int]:
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def _safe_float(v) -> Optional[float]:
    try:
        return float(v)
    except (TypeError, ValueError):
        return None
