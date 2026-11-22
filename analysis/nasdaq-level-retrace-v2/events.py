"""Touch crosses of every active level, plus the forward exit walk.

Prices are handled in integer price-steps so a level and a bar are never
compared through a float rounding.  The step is 10^-decimals of the instrument
(100 per point on US100, 100,000 per point on GBPUSD).  ``SPREAD_C`` is the
1.3 point spread in those steps.

A level L can be entered two ways on a touch:

* a sell is filled when the bid reaches L, so the trigger is bid = L.
* a buy pays the ask, so the buy trigger is bid = L - 1.3 points.

Either way the trade is valued at L, so ``pnl = side * (exit_bid - L)`` in
price-steps.  A 50 point target therefore nets exactly 50 points, and the 1.3
point spread shows up as the bid having to travel 1.3 points further before a
buy triggers.  The exit walk starts at the trigger bid (not at L), so the
immediate negative mark of a fresh buy is part of the excursion.

A 1-minute close does not use that trigger.  Continuation needs the bar's own
body to finish on the other side of the level (close above buys, close below
sells).  A wick through a second level on that same bar is not a close.
Reversal needs a prior bar to have closed beyond the level, and this bar to
close back through it.  The fill is that close, plus the spread on a buy, and
the stop and target are measured from the fill.

All price arrays handed to the walk are integer price-steps.  The njit
functions take the spread as an argument because numba bakes module globals
into its disk cache, which would leak one instrument's spread into another.
"""
from __future__ import annotations

import numpy as np
from numba import njit

import config
import data
import levels

BLOCK = 64
SCALE = 100.0
SPREAD_C = int(round(config.SPREAD * 100))


def set_scale(scale, point):
    """Switch the integer step to an instrument: 10^decimals per price unit."""
    global SCALE, SPREAD_C
    SCALE = float(scale)
    SPREAD_C = int(round(config.SPREAD * point * scale))


def cents(values):
    return np.rint(np.asarray(values, dtype=np.float64) * SCALE).astype(np.int32)


def bar_cents(bars):
    """Open, high, low and close as integer cents, ready for the walk."""
    return cents(bars["o"]), cents(bars["h"]), cents(bars["l"]), cents(bars["c"])


def prepare_blocks(h, l):
    starts = np.arange(0, len(h), BLOCK)
    return np.minimum.reduceat(l, starts), np.maximum.reduceat(h, starts)


def _crossings(a, b, price_cents, shift):
    """Every level crossed by one path segment, in path order."""
    up = b > a
    down = b < a
    if not up.any() and not down.any():
        empty = np.empty(0, dtype=np.int64)
        return empty, empty, np.empty(0, dtype=np.float64), np.empty(0, dtype=bool)
    a64 = a.astype(np.int64)
    b64 = b.astype(np.int64)
    lo_up = np.searchsorted(price_cents, a64 + shift, side="right")
    hi_up = np.searchsorted(price_cents, b64 + shift, side="right")
    lo_dn = np.searchsorted(price_cents, b64 + shift, side="left")
    hi_dn = np.searchsorted(price_cents, a64 + shift, side="left")
    count = np.where(up, hi_up - lo_up, np.where(down, hi_dn - lo_dn, 0)).astype(np.int64)
    sel = np.flatnonzero(count)
    if sel.size == 0:
        empty = np.empty(0, dtype=np.int64)
        return empty, empty, np.empty(0, dtype=np.float64), np.empty(0, dtype=bool)
    take = count[sel]
    total = int(take.sum())
    rep = np.repeat(sel, take)
    start = np.repeat(np.cumsum(take) - take, take)
    offset = np.arange(total, dtype=np.int64) - start
    k = np.where(up[rep], lo_up[rep] + offset, hi_dn[rep] - 1 - offset)
    trigger = price_cents[k] - shift
    frac = (trigger - a64[rep]) / (b64[rep] - a64[rep])
    return rep, k, frac, up[rep]


def _append(store, key, values):
    store[key].append(np.asarray(values))


def _concat(store):
    return {key: (np.concatenate(parts) if parts else np.empty(0, dtype=dtype))
            for key, (parts, dtype) in store.items()}


def _empty_store():
    return {
        "bar": ([], np.int32),
        "seg": ([], np.int8),
        "dir": ([], np.int8),
        "variant": ([], np.int8),
        "cents": ([], np.int32),
        "lday": ([], np.int32),
        "fill": ([], np.int32),
        "rank": ([], np.int16),
        "day": ([], np.int32),
    }


def generate(bars, clocks, records, lvl, progress=None):
    """Every touch cross of every active level during London or New York."""
    n = len(bars["ts"])
    oc, oh, ol, occ = cents(bars["o"]), cents(bars["h"]), cents(bars["l"]), cents(bars["c"])
    ny_day = clocks["ny_day"]
    in_all = clocks["in_all"]
    event_days = np.unique(ny_day[in_all])
    store = _empty_store()
    books = levels.iter_books(records, event_days)
    start = 0
    done = 0
    total = len(event_days)
    for day, book_cents, _kind, _rec, book_lday, _changed in books:
        while start < n and ny_day[start] < day:
            start += 1
        end = start
        while end < n and ny_day[end] == day:
            end += 1
        idx = np.arange(start, end, dtype=np.int64)
        idx = idx[in_all[start:end]]
        start = end
        done += 1
        if progress is not None and done % 200 == 0:
            progress(done, total)
        if idx.size == 0 or book_cents.size == 0:
            continue
        prev = np.where(idx > 0, occ[idx - 1], oc[idx]).astype(np.int32)
        p1 = oc[idx]
        p4 = occ[idx]
        bull = p4 >= p1
        p2 = np.where(bull, ol[idx], oh[idx]).astype(np.int32)
        p3 = np.where(bull, oh[idx], ol[idx]).astype(np.int32)
        segments = ((prev, p1), (p1, p2), (p2, p3), (p3, p4))
        day_parts = {key: [] for key in store}
        for seg, (a, b) in enumerate(segments):
            if seg == 0:
                gap = prev != p1
            else:
                gap = None
            for variant, shift in ((0, 0), (1, SPREAD_C)):
                rep, k, frac, up = _crossings(a, b, book_cents, shift)
                if rep.size == 0:
                    continue
                bar = idx[rep].astype(np.int32)
                level = book_cents[k]
                fill = (level - shift).astype(np.int32)
                rank = (np.floor(frac * 999.0)).astype(np.int16) + np.int16(seg * 1000)
                if seg == 0:
                    gap_here = gap[rep]
                    fill = np.where(gap_here, p1[rep], fill).astype(np.int32)
                    rank = np.where(gap_here, np.int16(seg * 1000 + 999), rank).astype(np.int16)
                day_parts["bar"].append(bar)
                day_parts["seg"].append(np.full(rep.size, seg, dtype=np.int8))
                day_parts["dir"].append(np.where(up, np.int8(1), np.int8(-1)))
                day_parts["variant"].append(np.full(rep.size, variant, dtype=np.int8))
                day_parts["cents"].append(level.astype(np.int32))
                day_parts["lday"].append(book_lday[k].astype(np.int32))
                day_parts["fill"].append(fill)
                day_parts["rank"].append(rank)
                day_parts["day"].append(np.full(rep.size, day, dtype=np.int32))
        if not day_parts["bar"]:
            continue
        merged = {key: np.concatenate(parts) for key, parts in day_parts.items()}
        order = np.lexsort((merged["rank"], merged["bar"]))
        for key in store:
            store[key][0].append(merged[key][order])
    return _concat(store)


@njit(cache=True, inline="always")
def _walk_segment(a, b, stop, tgt, run_lo, run_hi):
    done = False
    kind = -1
    px = 0
    frac = 0.0
    span = b - a
    if span == 0:
        if a == stop:
            done, kind, px = True, 0, a
        elif a == tgt:
            done, kind, px = True, 1, a
    else:
        fs = (stop - a) / span
        ft = (tgt - a) / span
        s_in = (fs >= 0.0) and (fs <= 1.0)
        t_in = (ft >= 0.0) and (ft <= 1.0)
        if s_in and (not t_in or fs <= ft):
            done, kind, px, frac = True, 0, stop, fs
        elif t_in:
            done, kind, px, frac = True, 1, tgt, ft
    if done:
        if px > run_hi:
            run_hi = px
        if px < run_lo:
            run_lo = px
    else:
        if b > run_hi:
            run_hi = b
        if b < run_lo:
            run_lo = b
    return done, kind, px, frac, run_lo, run_hi


@njit(cache=True)
def walk(side, start, value, sl_c, tp_c, bar_i, seg_i, o, h, l, c, blo, bhi):
    """First stop or target on the bid path, and the extremes on the way.

    ``start`` is the bid at the trigger, ``value`` is the level the trade is
    valued at.  A segment starts mid-way for a touch, ``seg_i == 4`` starts
    after the entry bar's close for a confirmation.
    """
    n = c.size
    stop = value - side * sl_c
    tgt = value + side * tp_c
    run_lo = start
    run_hi = start
    done = False
    kind = 2
    px = c[n - 1]
    ebar = n - 1
    esub = 9999

    p1 = o[bar_i]
    p2 = l[bar_i] if c[bar_i] >= p1 else h[bar_i]
    p3 = h[bar_i] if c[bar_i] >= p1 else l[bar_i]
    p4 = c[bar_i]

    seg = seg_i
    a = start
    while seg < 4:
        if seg == 0:
            b = p1
        elif seg == 1:
            b = p2
        elif seg == 2:
            b = p3
        else:
            b = p4
        hit, hit_kind, hit_px, frac, run_lo, run_hi = _walk_segment(a, b, stop, tgt, run_lo, run_hi)
        if hit:
            done = True
            kind = hit_kind
            px = hit_px
            ebar = bar_i
            esub = seg * 1000 + int(frac * 999.0)
            break
        a = b
        seg += 1

    if not done:
        j = bar_i + 1
        prev = c[bar_i]
        while j < n:
            blk = j // BLOCK
            if (j % BLOCK) == 0 and blk < blo.size:
                lo_b = blo[blk]
                hi_b = bhi[blk]
                lo2 = lo_b if lo_b < prev else prev
                hi2 = hi_b if hi_b > prev else prev
                if not ((lo2 <= stop <= hi2) or (lo2 <= tgt <= hi2)):
                    if lo2 < run_lo:
                        run_lo = lo2
                    if hi2 > run_hi:
                        run_hi = hi2
                    j = (blk + 1) * BLOCK
                    if j > n:
                        j = n
                    prev = c[j - 1]
                    continue
            q0 = prev
            q1 = o[j]
            qbull = c[j] >= o[j]
            q2 = l[j] if qbull else h[j]
            q3 = h[j] if qbull else l[j]
            q4 = c[j]
            a = q0
            for s in range(4):
                if s == 0:
                    b = q1
                elif s == 1:
                    b = q2
                elif s == 2:
                    b = q3
                else:
                    b = q4
                hit, hit_kind, hit_px, frac, run_lo, run_hi = _walk_segment(a, b, stop, tgt, run_lo, run_hi)
                if hit:
                    done = True
                    kind = hit_kind
                    px = hit_px
                    ebar = j
                    esub = s * 1000 + int(frac * 999.0)
                    break
                a = b
            if done:
                break
            prev = q4
            j += 1
        if not done:
            ebar = n - 1
            esub = 9999
            px = c[n - 1]

    pnl = side * (px - value)
    if side > 0:
        mae = value - run_lo
        mfe = run_hi - value
    else:
        mae = run_hi - value
        mfe = value - run_lo
    return pnl, kind, ebar, esub, mae, mfe


@njit(cache=True)
def resolve(entry, e_bar, e_seg, e_var, e_cents, e_fill, c, o, h, l, cc,
            spread_c, sl_c, tp_c, blo, bhi,
            out_pnl, out_kind, out_ebar, out_esub, out_mae, out_mfe):
    """Exit walk for every event, for one stop, one target and one entry mode.

    Touch entries start at the bid trigger stored in ``e_fill`` (the level, or
    the open of a gap).  A buy is valued at the ask, one spread above that bid.
    A 1-minute close is valued at the entry bar's close, plus the spread on a
    buy, and the stop and target are measured from that price.  The exit scan
    starts on the next bar.  Prices are integer price-steps.
    """
    n = e_bar.size
    for i in range(n):
        b = e_bar[i]
        if entry == 0:
            side = 1 if e_var[i] == 1 else -1
            start = e_fill[i]
            seg = e_seg[i]
        else:
            close = c[b]
            level = e_cents[i]
            if close == level:
                out_kind[i] = -1
                continue
            side = 1 if close > level else -1
            start = close
            seg = 4
        value = start + spread_c if side > 0 else start
        pnl, kind, ebar, esub, mae, mfe = walk(side, start, value, sl_c, tp_c, b, seg, o, h, l, cc, blo, bhi)
        out_pnl[i] = pnl
        out_kind[i] = kind
        out_ebar[i] = ebar
        out_esub[i] = esub
        out_mae[i] = mae
        out_mfe[i] = mfe


def confirm_side(typ, opened, prev_close, close, level, has_prev):
    """1 buy, -1 sell, 0 when this bar is not a 1-minute-close signal.

    Continuation (``typ`` 1): the body itself crossed the level.  Close above
    the level buys, close below sells.  A wick that comes back before the close
    does not qualify, so a second level only touched by that wick is ignored.

    Reversal (``typ`` -1): a previous bar closed beyond the level, and this
    bar's close came back through it.  Close back below sells, close back above
    buys.  The fill for either type is this bar's close, not the level.
    """
    if typ == 1:
        if opened < level < close:
            return 1
        if close < level < opened:
            return -1
        return 0
    if not has_prev:
        return 0
    if prev_close < level < close:
        return 1
    if close < level < prev_close:
        return -1
    return 0


def base_mask(e_bar, e_dir, e_var, e_cents, e_lday, close_c, open_c, e_day,
              in_lon, in_ny, in_rth, entry, typ, look, sess, skip=None):
    """Events this run may trade, ignoring the once-per-level-per-day rule.

    The run's session, lookback, entry mode and trade type are all fixed here,
    so the expensive per-run walk only ever sees its own candidates.  ``skip``
    is an optional per-bar mask of bars this run never enters in (the first
    minute of the cash open), so the same event list serves instruments that do
    and that do not have that rule.
    """
    bar = e_bar
    if entry == 0:
        side = np.where(e_var == 1, 1, -1)
        valid = np.ones(bar.size, dtype=bool)
        # the same side as the crossing is a continuation, the other side is a fade
        implied = np.where((side == 1) == (e_dir == 1), 1, -1)
        keep = valid & (implied == typ)
    else:
        close = close_c[bar]
        level = e_cents
        if typ == 1:
            opened = open_c[bar]
            buy = (opened < level) & (close > level)
            sell = (close < level) & (opened > level)
        else:
            prev_i = np.maximum(bar.astype(np.int64) - 1, 0)
            prev = close_c[prev_i]
            has_prev = bar > 0
            buy = has_prev & (prev < level) & (close > level)
            sell = has_prev & (close < level) & (prev > level)
        keep = buy | sell
    if sess == 0:
        keep &= in_lon[bar]
    elif sess == 1:
        keep &= in_ny[bar]
    elif sess == 2:
        keep &= in_rth[bar]
    else:
        keep &= in_lon[bar] | in_ny[bar]
    if skip is not None:
        keep &= ~skip[bar]
    if look is not None and look >= 0:
        keep &= (e_day - e_lday) <= look
    return np.flatnonzero(keep)


@njit(cache=True)
def pick_first_per_level(sel, e_cents, e_day, out):
    """First event per level and day (one trade per level per day)."""
    n = 0
    used = np.empty(4096, dtype=np.int32)
    n_used = 0
    day = np.int32(-2147483648)
    for a in range(sel.size):
        i = sel[a]
        d = e_day[i]
        if d != day:
            day = d
            n_used = 0
        level = e_cents[i]
        seen = False
        for u in range(n_used):
            if used[u] == level:
                seen = True
                break
        if seen:
            continue
        if n_used < used.size:
            used[n_used] = level
            n_used += 1
        out[n] = i
        n += 1
    return n


@njit(cache=True)
def pick_first_per_day(sel, e_day, out):
    n = 0
    day = np.int32(-2147483648)
    for a in range(sel.size):
        i = sel[a]
        if e_day[i] != day:
            day = e_day[i]
            out[n] = i
            n += 1
    return n


@njit(cache=True)
def simulate_serial(idx, e_bar, e_rank, e_cents, e_day, bar_day,
                    ex_bar, ex_sub, ex_pnl, ex_kind, ex_mae, ex_mfe,
                    until, day_cap,
                    out_idx, out_pnl, out_kind, out_ebar, out_esub, out_mae, out_mfe):
    """One position at a time over the pre-filtered events.

    ``idx`` are the original event indices and every other array is already
    sliced by ``idx``.  A trade blocks new entries until its exit, and
    ``until`` stops a day once the realised profit reaches the cap.
    """
    n = idx.size
    n_out = 0
    used = np.empty(4096, dtype=np.int32)
    n_used = 0
    day = np.int32(-2147483648)
    day_pnl = 0
    capped = False
    i = 0
    while i < n:
        d = e_day[i]
        if d != day:
            day = d
            n_used = 0
            day_pnl = 0
            capped = False
        if capped:
            j = np.searchsorted(e_day, d + 1, side="left")
            i = j if j > i else i + 1
            continue
        level = e_cents[i]
        seen = False
        for u in range(n_used):
            if used[u] == level:
                seen = True
                break
        if seen:
            i += 1
            continue
        if n_used < used.size:
            used[n_used] = level
            n_used += 1
        out_idx[n_out] = idx[i]
        out_pnl[n_out] = ex_pnl[i]
        out_kind[n_out] = ex_kind[i]
        out_ebar[n_out] = ex_bar[i]
        out_esub[n_out] = ex_sub[i]
        out_mae[n_out] = ex_mae[i]
        out_mfe[n_out] = ex_mfe[i]
        n_out += 1
        if bar_day[ex_bar[i]] == d:
            day_pnl += ex_pnl[i]
        if until and day_pnl >= day_cap:
            capped = True
        xb = ex_bar[i]
        xs = ex_sub[i]
        j = np.searchsorted(e_bar, xb, side="left")
        if j <= i:
            j = i + 1
        while j < n and e_bar[j] == xb and e_rank[j] <= xs:
            j += 1
        i = j
    return n_out
