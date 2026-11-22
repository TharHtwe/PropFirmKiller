"""Run metrics, following the definitions page of the previous report.

A win is a trade whose points are above zero; a zero counts as a loss for the
win rate and for the loss count, but not in the profit factor.  Equity is in
index points on one contract, in trade order.
"""
from __future__ import annotations

import numpy as np

EQUITY_POINTS = 160


def _pct(a):
    return round(float(a) * 100.0, 1)


def _run_lengths(win):
    """Length of the win/loss streak that ends at each trade."""
    n = win.size
    idx = np.arange(n)
    reset = np.r_[True, win[1:] != win[:-1]]
    last = np.maximum.accumulate(np.where(reset, idx, 0))
    return idx - last + 1


def _streak_tables(win, run_len):
    """After k losses and after k wins: sample count and next-trade win rate."""
    out = {"after_loss_streaks": [], "after_win_streaks": []}
    prev_win = win[:-1]
    next_win = win[1:]
    tail = run_len[:-1]
    for k in range(1, 16):
        for key, want in (("after_loss_streaks", False), ("after_win_streaks", True)):
            mask = (tail >= k) & (prev_win == want)
            samples = int(mask.sum())
            if not samples:
                out[key].append(None)
                continue
            wins = int(next_win[mask].sum())
            out[key].append({
                "k": k,
                "n": samples,
                "next_win_pct": _pct(wins / samples),
                "next_loss_pct": _pct(1.0 - wins / samples),
            })
    for key in out:
        rows = out[key]
        while rows and rows[-1] is None:
            rows.pop()
        out[key] = [r for r in rows if r is not None]
    return out


def _corr(a, b):
    if a.size < 3:
        return None
    a = a.astype(np.float64)
    b = b.astype(np.float64)
    a = a - a.mean()
    b = b - b.mean()
    den = np.sqrt((a * a).sum() * (b * b).sum())
    if den == 0.0:
        return 0.0
    return round(float((a * b).sum() / den), 3)


def _band(gap):
    g = abs(gap)
    if g > 8:
        return "extreme"
    if g > 6:
        return "stronger"
    if g > 4:
        return "solid"
    if g > 2:
        return "weak"
    return "none"


_KELLY = {"none": 0.0, "weak": 0.2, "solid": 1.0 / 3.0, "stronger": 0.5}


def _empty():
    return {
        "trades": 0, "wins": 0, "losses": 0, "win_rate": 0.0, "net_points": 0.0,
        "expectancy": 0.0, "profit_factor": None, "profit_factor_without_best": None,
        "max_drawdown": 0.0, "max_drawdown_trades": 0, "payoff": None,
        "avg_win": None, "avg_loss": None, "longs": 0, "shorts": 0,
        "long_net": 0.0, "short_net": 0.0, "targets": 0, "stops": 0, "forced": 0,
        "chunks": [], "autocorrelation": {}, "streaks": {"longest_win": 0, "longest_loss": 0},
        "hold": {}, "daily": {}, "excursion": {}, "hourly": [], "weekday": [],
        "equity": [], "period": {},
    }


def compute(pnl_c, kind, ebar, esub, mae_c, mfe_c, side, day, ent_bar, hour, weekday, sl_pts, scale):
    """Metrics for one run.

    ``pnl_c`` and the excursion arrays are integer price-steps (10^-decimals of
    the instrument), ``day`` is the New York date of the entry bar, ``hour``
    is the UTC hour and ``weekday`` 0-6 of that date.
    """
    del esub
    n = int(pnl_c.size)
    if n == 0:
        return _empty()

    pnl = pnl_c.astype(np.float64) / scale
    win = pnl > 0.0
    wins = int(win.sum())
    losses = n - wins
    net = float(pnl.sum())
    cum = np.cumsum(pnl)

    path = np.r_[0.0, cum]
    peak = np.maximum.accumulate(path)
    under = path < peak
    max_dd = float((peak - path).max())
    if under.any():
        edges = np.flatnonzero(np.diff(np.r_[0, under.astype(np.int8), 0]))
        longest_under = int((edges[1::2] - edges[0::2]).max())
    else:
        longest_under = 0

    pos = pnl[win]
    neg = pnl[pnl < 0.0]
    gross_win = float(pos.sum())
    gross_loss = float(-neg.sum())
    pf = round(gross_win / gross_loss, 3) if gross_loss > 0 else None
    if wins > 1 and gross_loss > 0:
        pf_x = round((gross_win - float(pos.max())) / gross_loss, 3)
    else:
        pf_x = None

    other = pnl[~win]
    payoff = round(float(pos.mean()) / abs(float(other.mean())), 3) if pos.size and other.size else None

    long_m = side > 0
    shorts = int((~long_m).sum())

    chunks = []
    if n >= 10:
        size = n // 10
        chunks = [_pct(win[b * size:(b + 1) * size].mean()) for b in range(10)]

    run_len = _run_lengths(win)
    longest_win = int(run_len[win].max()) if wins else 0
    longest_loss = int(run_len[~win].max()) if losses else 0

    ac = {}
    if n > 1:
        w = win.astype(np.float64)
        p_uncond = float(win.mean())
        after_loss = ~win[:-1]
        after_win = win[:-1]
        n_al = int(after_loss.sum())
        n_aw = int(after_win.sum())
        p_al = float(win[1:][after_loss].mean()) if n_al else None
        p_aw = float(win[1:][after_win].mean()) if n_aw else None
        gap = None if p_al is None else _pct(p_uncond - p_al)
        band = _band(gap) if gap is not None else "none"
        kelly_full = None
        if pos.size and neg.size:
            kelly_full = round(float(p_uncond) - (1.0 - float(p_uncond)) / (float(pos.mean()) / float(sl_pts)), 4)
        fraction = _KELLY.get(band)
        ac = {
            "trades": n,
            "unconditional_win_pct": _pct(p_uncond),
            "after_loss": n_al,
            "conditional_win_pct": None if p_al is None else _pct(p_al),
            "after_win": n_aw,
            "after_win_win_pct": None if p_aw is None else _pct(p_aw),
            "gap": gap,
            "sign": "negative" if gap is not None and gap < -2 else ("positive" if gap is not None and gap > 2 else "zero"),
            "band": band,
            "pearson_winloss": _corr(w[:-1], w[1:]),
            "pearson_points": _corr(pnl[:-1], pnl[1:]),
            "kelly_full": kelly_full,
            "kelly_fraction": None if fraction is None else f"{fraction:.3f}",
            "kelly_bet": None if (kelly_full is None or fraction is None) else round(kelly_full * fraction, 4),
        }
        ac.update(_streak_tables(win, run_len))

    uniq, inv = np.unique(day, return_inverse=True)
    daily_sum = np.bincount(inv, weights=pnl)
    best = int(daily_sum.argmax())
    worst = int(daily_sum.argmin())
    swing = (round(float(daily_sum.mean() / daily_sum.std()), 3)
             if daily_sum.size > 1 and daily_sum.std() > 0 else None)

    hold = ebar - ent_bar
    winners = pnl > 0.0
    losers = ~winners
    mae_pts = mae_c / scale
    mfe_pts = mfe_c / scale
    near_stop = winners & (mae_pts >= 0.9 * sl_pts)
    exc = {}
    if winners.any():
        wm = mae_pts[winners]
        exc.update({
            "winners_mae_avg": round(float(wm.mean()), 1),
            "winners_mae_median": round(float(np.median(wm)), 1),
            "winners_mae_p90": round(float(np.percentile(wm, 90)), 1),
            "winners_mae_max": round(float(wm.max()), 1),
            "winners_near_stop": int(near_stop.sum()),
            "winners_near_stop_pct": _pct(near_stop.sum() / wins),
        })
    if losers.any():
        lm = mfe_pts[losers]
        exc.update({
            "losers_mfe_avg": round(float(lm.mean()), 1),
            "losers_mfe_median": round(float(np.median(lm)), 1),
            "losers_mfe_p90": round(float(np.percentile(lm, 90)), 1),
        })
    exc["mae_avg"] = round(float(mae_pts.mean()), 1)
    exc["mfe_avg"] = round(float(mfe_pts.mean()), 1)

    hour_sum = np.bincount(hour, weights=pnl, minlength=24)
    hour_n = np.bincount(hour, minlength=24)
    hour_w = np.bincount(hour[win], minlength=24)
    hourly = [{"hour": h, "trades": int(hour_n[h]), "win_rate": _pct(hour_w[h] / hour_n[h]),
               "net_points": round(float(hour_sum[h]), 1)}
              for h in range(24) if hour_n[h]]
    wd_sum = np.bincount(weekday, weights=pnl, minlength=7)
    wd_n = np.bincount(weekday, minlength=7)
    wd_w = np.bincount(weekday[win], minlength=7)
    by_weekday = [{"weekday": d, "trades": int(wd_n[d]), "win_rate": _pct(wd_w[d] / wd_n[d]),
                   "net_points": round(float(wd_sum[d]), 1)}
                  for d in range(7) if wd_n[d]]

    idx = np.unique(np.linspace(0, n - 1, EQUITY_POINTS).round().astype(np.int64))
    equity = [round(float(cum[i]), 1) for i in idx]

    return {
        "trades": n,
        "wins": wins,
        "losses": losses,
        "win_rate": _pct(win.mean()),
        "net_points": round(net, 1),
        "expectancy": round(net / n, 2),
        "profit_factor": pf,
        "profit_factor_without_best": pf_x,
        "max_drawdown": round(max_dd, 1),
        "max_drawdown_trades": longest_under,
        "payoff": payoff,
        "avg_win": round(float(pos.mean()), 1) if pos.size else None,
        "avg_loss": round(float(neg.mean()), 1) if neg.size else None,
        "longs": n - shorts,
        "shorts": shorts,
        "long_net": round(float(pnl[long_m].sum()), 1) if long_m.any() else 0.0,
        "short_net": round(float(pnl[~long_m].sum()), 1) if (~long_m).any() else 0.0,
        "targets": int((kind == 1).sum()),
        "stops": int((kind == 0).sum()),
        "forced": int((kind == 2).sum()),
        "chunks": chunks,
        "autocorrelation": ac,
        "streaks": {"longest_win": longest_win, "longest_loss": longest_loss},
        "hold": {
            "avg_bars": round(float(hold.mean()), 1),
            "median_bars": round(float(np.median(hold)), 1),
            "max_bars": int(hold.max()),
        },
        "daily": {
            "days": int(uniq.size),
            "trades_per_day": round(n / uniq.size, 2),
            "positive_days_pct": _pct((daily_sum > 0).sum() / uniq.size),
            "best_day": {"day": int(uniq[best]), "points": round(float(daily_sum[best]), 1)},
            "worst_day": {"day": int(uniq[worst]), "points": round(float(daily_sum[worst]), 1)},
            "return_swing": swing,
        },
        "excursion": exc,
        "hourly": hourly,
        "weekday": by_weekday,
        "equity": equity,
        "period": {"first": int(uniq[0]), "last": int(uniq[-1])},
    }


def factor_table(runs, factors):
    """Mean, median, best and worst net per option, on the given runs."""
    out = {}
    for f in factors:
        rows = []
        for value, label in f["options"]:
            nets = [r["metrics"]["net_points"] for r in runs if r["cfg"][f["key"]] == value]
            if not nets:
                rows.append({"value": value, "label": label, "runs": 0})
                continue
            arr = np.asarray(nets, dtype=np.float64)
            rows.append({
                "value": value,
                "label": label,
                "runs": int(arr.size),
                "mean": round(float(arr.mean()), 1),
                "median": round(float(np.median(arr)), 1),
                "best": round(float(arr.max()), 1),
                "worst": round(float(arr.min()), 1),
            })
        out[f["key"]] = rows
    return out
