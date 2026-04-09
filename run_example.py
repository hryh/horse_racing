"""
Quick-start example
-------------------
Shows a full workflow:
  1. Load historical CSV
  2. Train the model
  3. Back-test on 2015-2016 (same split as the paper)
  4. (Optional) Live prediction from HKJC API

Run:
    python -m horse_racing.run_example --csv hkjc_results.csv
"""
import argparse
import pandas as pd

from horse_racing.data_fetcher import load_historical_csv, get_race_card
from horse_racing.predictor    import HorseRacingPredictor


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--csv",    help="Path to historical CSV file")
    parser.add_argument("--models", default="models/", help="Dir to save/load models")
    parser.add_argument("--live",   action="store_true", help="Run live prediction")
    parser.add_argument("--venue",  default="HV", choices=["HV", "ST"])
    parser.add_argument("--date",   default=None, help="YYYY-MM-DD for live fetch")
    args = parser.parse_args()

    predictor = HorseRacingPredictor(
        dnn_weight=0.65,
        pattern_weight=0.35,
        dnn_threshold=0.25,   # ~3x base rate for ~12-runner fields
        dnn_epochs=300,
        kelly_frac=0.25,
        min_edge=0.05,
    )

    # ── Train ──────────────────────────────────────────────────────────────
    if args.csv:
        print(f"Loading data from {args.csv} …")
        df = load_historical_csv(args.csv)

        # Dynamic split: train on all but the last 12 months, test on the rest
        max_date   = df["date"].max()
        split_date = max_date - pd.DateOffset(months=12)
        train_df   = df[df["date"] <= split_date]
        test_df    = df[df["date"] >  split_date]

        print(f"Train rows: {len(train_df):,}  ({df['date'].min().date()} – {split_date.date()})")
        print(f"Test rows:  {len(test_df):,}  ({(split_date + pd.DateOffset(days=1)).date()} – {max_date.date()})")
        predictor.fit(train_df, verbose=1, checkpoint_dir=args.models)
        predictor.save(args.models)

        print("\n-- Back-test (last 12 months) ------------------------------------")
        stats = predictor.backtest(test_df, train_df, verbose=1)

        # Baseline: always bet on the race favourite (lowest win_odds)
        fav_wins = sum(
            1 for _, g in test_df.groupby(["date", "location", "race_no"])
            if not g.empty and
               g.loc[g["win_odds"].astype(float).idxmin(), "won"] == 1
        )
        fav_total = test_df.groupby(["date", "location", "race_no"]).ngroups
        fav_rate  = fav_wins / fav_total if fav_total else 0.0

        print(f"\nFavourite baseline win rate = {fav_rate:.3f}  ({fav_wins}/{fav_total} races)")
        print(f"Our model win rate          = {stats['win_rate']:.3f}  ({stats['wins']}/{stats['total_bets']} bets, {stats['total_bets']/fav_total*100:.0f}% of races)")
        print(f"Our model flat ROI          = {stats['flat_roi']*100:.1f}%  (per 1-unit bet)")

    # ── Live prediction ───────────────────────────────────────────────────
    if args.live:
        try:
            predictor = HorseRacingPredictor.load(args.models)
        except Exception as e:
            print(f"Could not load saved model: {e}")
            return

        print(f"\nFetching live race card: venue={args.venue} date={args.date or 'today'}")
        card = get_race_card(race_date=args.date, venue=args.venue)
        results = predictor.predict_card(card)

        print(f"\n{'='*60}")
        for r in results:
            bet = r["best_bet"]
            print(f"\nRace {r['race_no']} — {r['date']} @ {r['venue']}")
            print(f"  All horses (by prob):")
            for dec in r["decisions"]:
                flag = "*** BET ***" if dec.should_bet else ""
                print(
                    f"    {dec.horse_name:<25} "
                    f"P={dec.win_prob:.3f}  "
                    f"odds={dec.win_odds:.1f}  "
                    f"EV={dec.expected_value:.3f}  {flag}"
                )
            if bet:
                pct = bet.bet_fraction * 100
                print(f"  >> BET: {bet.horse_name}  stake={pct:.1f}% of bankroll")
            else:
                print("  >> No bet this race (below confidence/EV threshold)")


if __name__ == "__main__":
    main()
