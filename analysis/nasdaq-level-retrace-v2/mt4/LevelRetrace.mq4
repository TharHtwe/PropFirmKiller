//+------------------------------------------------------------------+
//|                                                  LevelRetrace.mq4 |
//|  MetaTrader 4 port of the level-retrace v2 strategy.             |
//|                                                                  |
//|  LEVELS   the open and the close of every COMPLETED daily and    |
//|           weekly candle.  A candle only becomes a level on the   |
//|           next trade day, so a trade never uses a forming candle.|
//|  ENTRY    continuation on a touch: a long is a BUY STOP at the   |
//|           level (a buy stop can only be hit from below, which is |
//|           the engine's continuation filter by construction) and  |
//|           the level is the ask, so the modelled 1.3 point spread |
//|           is paid on entry.  A short is a SELL STOP at the level.|
//|  EXIT     stop and target sit on the bid path, like the engine.  |
//|           MT4 closes a long at the bid, so a long's stops go on  |
//|           the engine's bid levels untouched.  It closes a short  |
//|           at the ask, so a short's stops move out by the live    |
//|           spread (InpAdjustShortStops) to stay on those bids.    |
//|  CLOCK    sessions are New York 08:00-17:00, London 08:00-16:30  |
//|           and cash 09:30-16:00, each in its own zone's local     |
//|           time.  MT4 only hands the EA server time, so the       |
//|           server offset is an input (or detected from TimeGMT)   |
//|           and daylight saving comes from the zone rules, never    |
//|           from a fixed offset.                                    |
//|                                                                  |
//|  Read mt4/README.md before the first run: what the model assumes,|
//|  where a live fill differs and how to read the dollar result.    |
//+------------------------------------------------------------------+
#property copyright "level-retrace v2"
#property version   "1.00"
#property strict
#property description "Daily and weekly open/close level touches, continuation, touch entry."
#property description "Level-retrace v2 port. Read mt4/README.md before the first run."

#define LR_BIG       1000000000
#define LR_MAX_DAYS  3000
#define LR_SLOTS     64
#define LR_PACK_DAY  40000.0    // New York day numbers stay under this until 2079
#define LR_PACK      160000.0   // LR_PACK_DAY * 4, the base of a packed record

enum ENUM_SESSION
  {
   SESSION_LONDON = 0,    // London 08:00-16:30 London time
   SESSION_NEWYORK = 1,   // New York 08:00-17:00 New York time
   SESSION_RTH = 2,       // New York cash 09:30-16:00
   SESSION_BOTH = 3       // London or New York
  };

enum ENUM_LEVELSESSION
  {
   LEVELS_ALL = 0,        // every bar, grouped by the electronic market day
   LEVELS_ETH = 1,        // 18:00-17:00 New York, the break hour dropped
   LEVELS_RTH = 2         // 09:30-16:00 New York, grouped by New York date
  };

enum ENUM_LOOKBACK
  {
   LOOK_1M = 30,          // levels no older than 30 days
   LOOK_6M = 182,         // 182 days
   LOOK_1Y = 365,         // 365 days
   LOOK_ALL = 0           // no age limit
  };

enum ENUM_TPD
  {
   TPD_EVERY = 0,         // every level, one trade per level per day
   TPD_SERIAL = 1,        // one position at a time
   TPD_ONE = 2,           // one trade per day
   TPD_UNTIL = 3          // one at a time until the day reaches the target
  };

enum ENUM_EXIT
  {
   EXIT_BROKER_STOPS = 0, // stop and target live on the order
   EXIT_EA_BID = 1        // the EA closes on the bid, no broker stops
  };

//--- instrument and size -------------------------------------------------
input string  InpSep1             = "=== instrument and size ===";
input double  InpLots             = 0.10;          // Lot size
input double  InpPricePer50Points = 0.0;           // Price of 50 points (gold 5.0, US100 50.0, cable 0.005; 0 = auto)
input double  InpModelSpreadPts   = 1.3;           // Modelled spread, in points
input int     InpDigitsOverride   = 0;             // Price decimals used for level rounding (0 = symbol Digits)

//--- trade rules ----------------------------------------------------------
input string  InpSep2             = "=== trade rules ===";
input int     InpTargetPoints     = 50;            // Target, in points
input int     InpStopPoints       = 50;            // Stop loss, in points
input ENUM_SESSION      InpSession      = SESSION_NEWYORK; // Trading session
input ENUM_LEVELSESSION InpLevelSession = LEVELS_ETH;      // Level session
input ENUM_LOOKBACK     InpLookback     = LOOK_1Y;         // Level lookback
input ENUM_TPD          InpTradesPerDay = TPD_SERIAL;      // Trades per day

//--- clock ----------------------------------------------------------------
input string  InpSep3             = "=== clock ===";
input int     InpServerGmtOffset  = -99;           // Server minus UTC in hours (-99 = detect; the tester needs a number)
input bool    InpCheckAlignment   = true;          // Refuse to start if the level bars miss the session clock

//--- placement -------------------------------------------------------------
input string  InpSep4             = "=== placement ===";
input int     InpMaxPendingBuys   = 4;             // Max open buy stops (1 is forced in the single-position modes)
input int     InpMaxPendingSells  = 4;             // Max open sell stops
input int     InpLevelBandPoints  = 600;           // Only levels within this many points of the market
input int     InpLevelHistoryDays = 0;             // Days of candles used for levels (0 = lookback + 120)
input int     InpLevelBarMinutes  = 0;             // Candle source in minutes (0 = auto: 60, or 30 for cash levels)
input int     InpArmSeconds       = 2;             // Re-arm interval, seconds
input double  InpMaxSpreadPoints  = 0.0;           // Do not arm while the live spread exceeds this (0 = no check)
input int     InpMaxDailyTrades   = 0;             // Hard cap on entries per day (0 = unlimited)
input int     InpSlippagePoints   = 10;            // Slippage allowed for market orders, points

//--- exits ------------------------------------------------------------------
input string  InpSep5             = "=== exits ===";
input ENUM_EXIT InpExitMode       = EXIT_BROKER_STOPS; // Stop and target handling
input bool    InpAdjustShortStops = true;         // Shift a short's broker stops by the live spread (keeps the bid levels)
input bool    InpClosePendingsAtSessionEnd = true; // Remove unfilled stops when the session closes
input bool    InpCloseAtSessionEnd = false;        // Close open positions when the session closes

//--- misc --------------------------------------------------------------------
input string  InpSep6             = "=== misc ===";
input int     InpMagic            = 20261030;      // Magic number
input string  InpTag              = "LR";          // Order comment tag and log prefix
input bool    InpShowPanel        = true;          // Draw the status panel
input bool    InpWriteCsvLog      = true;          // Append closed trades to MQL4\Files

//--- runtime scale ---------------------------------------------------------
double g_stepScale     = 100.0;   // price steps in 1.00 of price
int    g_decimals      = 2;
double g_pricePerPoint = 1.0;     // price distance of one strategy point
double g_stepsPerPoint = 100.0;   // steps of one strategy point
int    g_spreadStep    = 130;     // modelled spread, steps
int    g_targetStep    = 5000;
int    g_stopStep      = 5000;
int    g_bandStep      = 60000;
int    g_lookDays      = 365;
int    g_srcTF         = PERIOD_H1;
int    g_serverOffH    = 0;       // server minus UTC, whole hours
int    g_gapStep       = 1;       // smallest distance the broker accepts
int    g_capBuy        = 1;
int    g_capSell       = 1;

//--- completed daily candles and the level records ------------------------
int      g_dcDay[];
double   g_dcOpen[];
double   g_dcClose[];
int      g_liveDay     = -1;
double   g_liveOpen    = 0.0;
double   g_liveClose   = 0.0;

int      g_recReady[];
int      g_recPrice[];
int      g_recDay[];
int      g_recKind[];              // 1 = daily, 2 = weekly

//--- the book of the current day, ascending by price ----------------------
int      g_bkPrice[];
int      g_bkDay[];                // newest candle that produced the price
int      g_bkKind[];
int      g_bkDayBuilt = -1;
double   g_pack[];                 // scratch: one sortable number per record

//--- daily state -----------------------------------------------------------
int      g_day = -1;               // current New York trade day
int      g_traded[];               // level steps already traded today
int      g_dayPnlStep = 0;         // points of trades that opened and closed today
bool     g_oneDone    = false;
bool     g_capped     = false;
int      g_dayTrades  = 0;
double   g_dayMoney   = 0.0;
int      g_dayClosed  = 0;

//--- tracked orders ---------------------------------------------------------
int      g_trkTicket[LR_SLOTS];
int      g_trkSide[LR_SLOTS];
int      g_trkValue[LR_SLOTS];     // the price the trade is valued at, steps
int      g_trkLevel[LR_SLOTS];     // the level that produced it, steps
int      g_trkDay[LR_SLOTS];
double   g_trkLots[LR_SLOTS];
int      g_armBuy   = 0;
int      g_armSell  = 0;
datetime g_lastArm  = 0;
datetime g_lastBar  = 0;

//--- statistics --------------------------------------------------------------
double   g_moneyTotal  = 0.0;
int      g_closed      = 0;
int      g_closedWins  = 0;
double   g_startEquity = 0.0;
string   g_stateName   = "";
string   g_csvName     = "";

//+------------------------------------------------------------------+
//| init                                                             |
//+------------------------------------------------------------------+
int OnInit()
  {
   g_decimals = (InpDigitsOverride > 0 ? InpDigitsOverride : Digits);
   if(g_decimals < 0 || g_decimals > 8)
     {
      Log("bad decimals override");
      return(INIT_PARAMETERS_INCORRECT);
     }
   g_stepScale = MathPow(10.0, g_decimals);

   double per50 = InpPricePer50Points;
   bool autoValue = (per50 <= 0.0);
   if(autoValue)
      per50 = AutoPricePer50();
   g_pricePerPoint = per50 / 50.0;
   g_stepsPerPoint = g_pricePerPoint * g_stepScale;
   if(g_stepsPerPoint < 1.0 || g_stepsPerPoint > 1.0e7)
     {
      Log("point scale unusable: one point would be " + DoubleToString(g_stepsPerPoint, 2) +
          " price steps. Set InpPricePer50Points to the price of 50 points" +
          " (gold 5.0, US100 50.0, cable 0.005).");
      return(INIT_PARAMETERS_INCORRECT);
     }
   if(MathAbs(g_stepsPerPoint - MathRound(g_stepsPerPoint)) > 0.001)
      Log("warning: the point value is not a whole number of price steps (" +
          DoubleToString(g_stepsPerPoint, 4) + "), levels get rounded.");

   g_targetStep = (int)MathRound(InpTargetPoints * g_stepsPerPoint);
   g_stopStep   = (int)MathRound(InpStopPoints * g_stepsPerPoint);
   g_spreadStep = (int)MathRound(InpModelSpreadPts * g_stepsPerPoint);
   g_bandStep   = (int)MathRound((double)InpLevelBandPoints * g_stepsPerPoint);
   if(g_bandStep <= 0)
      g_bandStep = LR_BIG;
   g_lookDays = (int)InpLookback;

   int historyDays = InpLevelHistoryDays;
   if(historyDays <= 0)
      historyDays = (g_lookDays > 0 ? g_lookDays : LR_MAX_DAYS) + 120;
   if(historyDays > LR_MAX_DAYS)
      historyDays = LR_MAX_DAYS;
   if(historyDays < 10)
      historyDays = 10;

   g_srcTF = LevelBarTF();
   if(!ResolveServerOffset())
      return(INIT_FAILED);

   g_capBuy  = PendingCap(InpMaxPendingBuys);
   g_capSell = PendingCap(InpMaxPendingSells);

   double gapPoints = MarketInfo(Symbol(), MODE_STOPLEVEL);
   double freezePoints = MarketInfo(Symbol(), MODE_FREEZELEVEL);
   if(freezePoints > gapPoints)
      gapPoints = freezePoints;
   g_gapStep = (int)MathRound(gapPoints * Point * g_stepScale);
   if(g_gapStep < 1)
      g_gapStep = 1;
   if(g_gapStep + g_spreadStep > g_stopStep / 2)
      Log("warning: the broker stop distance (" + IntegerToString(g_gapStep) + " steps) plus the" +
          " modelled spread is a large part of the " + IntegerToString(g_stopStep) +
          " step stop; the stops will sit further from the level than the model wants.");

   g_stateName = StringConcatenate(InpTag, InpMagic, "_", Symbol());
   g_csvName = StringConcatenate(InpTag, "_", Symbol(), "_", InpMagic, ".csv");

   if(!BuildLevels(historyDays))
      return(INIT_FAILED);
   if(InpCheckAlignment && !AlignmentOk())
      return(INIT_FAILED);

   g_day = NyDayOf(TimeCurrent());
   LoadDailyState();
   BuildBook(g_day);
   ReconcileBroker();
   g_startEquity = AccountEquity();

   Log("start " + Symbol() + " dp" + IntegerToString(g_decimals) +
       " point=" + DoubleToString(g_pricePerPoint, 8) + (autoValue ? " (auto)" : " (input)") +
       " 50pts=" + DoubleToString(per50, 8) + " stepsPerPoint=" + DoubleToString(g_stepsPerPoint, 2) +
       " stop=" + IntegerToString(g_stopStep) + " target=" + IntegerToString(g_targetStep) +
       " spreadModel=" + IntegerToString(g_spreadStep) + " records=" + IntegerToString(ArraySize(g_recReady)) +
       " book=" + IntegerToString(ArraySize(g_bkPrice)) + " candles=" + IntegerToString(ArraySize(g_dcDay)) +
       " srcTF=" + TFText(g_srcTF) + " historyDays=" + IntegerToString(historyDays) +
       " serverUTC" + (g_serverOffH >= 0 ? "+" : "") + IntegerToString(g_serverOffH) +
       " brokerGapSteps=" + IntegerToString(g_gapStep));
   return(INIT_SUCCEEDED);
  }

void OnDeinit(const int reason)
  {
   Comment("");
  }

//+------------------------------------------------------------------+
//| main loop                                                        |
//+------------------------------------------------------------------+
void OnTick()
  {
   UpdateLiveCandle();

   int dayNow = NyDayOf(TimeCurrent());
   if(dayNow != g_day)
     {
      g_day = dayNow;
      ResetDailyState();
      DeleteAllPendings();
      BuildBook(g_day);
      SaveDailyState();
      Log("new New York trading day " + DayText(g_day) + ", book has " +
          IntegerToString(ArraySize(g_bkPrice)) + " levels, " +
          IntegerToString(ArraySize(g_dcDay)) + " candles");
     }

   bool inSession = SessionOpen(TimeCurrent());

   TrackPositions();

   if(inSession)
     {
      datetime barTime = iTime(Symbol(), (ENUM_TIMEFRAMES)g_srcTF, 0);
      if(barTime != g_lastBar)
        {
         g_lastBar = barTime;
         PruneArmed();
        }
      Arm();
      ApplyStops();
     }
   else
     {
      if(InpClosePendingsAtSessionEnd)
         DeleteAllPendings();
      if(InpCloseAtSessionEnd)
         CloseAllPositions("session end");
     }

   if(InpExitMode == EXIT_EA_BID)
      MonitorBidExits();

   EnforceGates();

   if(InpShowPanel)
      UpdatePanel(inSession);
  }

//+------------------------------------------------------------------+
//| clock.  MT4 timestamps are server time; every session boundary   |
//| below is taken from the UTC instant of the bar and the daylight   |
//| saving rule of the zone itself.  Offsets multiply as plain ints:   |
//| casting a negative offset to datetime would wrap it.              |
//+------------------------------------------------------------------+
datetime GmtNow()
  {
   return(TimeCurrent() - g_serverOffH * 3600);
  }

datetime UtcOf(datetime serverEpoch)
  {
   return(serverEpoch - g_serverOffH * 3600);
  }

// a datetime whose calendar fields are the local wall clock of the zone
datetime LocalFields(datetime serverEpoch, int zoneOffH)
  {
   return(serverEpoch - g_serverOffH * 3600 + zoneOffH * 3600);
  }

int DayNumOf(datetime local)
  {
   return((int)MathFloor((double)local / 86400.0));
  }

int MinuteOfDay(datetime local)
  {
   return(TimeHour(local) * 60 + TimeMinute(local));
  }

int DowOf(datetime local)          // 0 = Sunday
  {
   int d = (DayNumOf(local) + 4) % 7;   // 1970.01.01 was a Thursday
   if(d < 0)
      d += 7;
   return(d);
  }

bool IsWeekday(int dow)
  {
   return(dow >= 1 && dow <= 5);
  }

int SundayOf(int dayNum)           // the Sunday that opens the week of a day
  {
   int d = (dayNum + 4) % 7;
   if(d < 0)
      d += 7;
   return(dayNum - d);
  }

// America/New_York: -5, and -4 from the second Sunday of March, 02:00 local,
// to the first Sunday of November, 02:00 local.  In UTC those instants are
// 07:00 and 06:00, which is how they are built here.
int NyOffsetAt(datetime gmt)
  {
   int year = TimeYear(gmt);
   datetime start = SundayWeekUtc(year, 3, 2) + 7 * 3600;
   datetime end = SundayWeekUtc(year, 11, 1) + 6 * 3600;
   return(gmt >= start && gmt < end ? -4 : -5);
  }

// Europe/London: 0, and +1 from the last Sunday of March 01:00 UTC to the last
// Sunday of October 01:00 UTC.
int LondonOffsetAt(datetime gmt)
  {
   int year = TimeYear(gmt);
   datetime start = LastSundayUtc(year, 3) + 3600;
   datetime end = LastSundayUtc(year, 10) + 3600;
   return(gmt >= start && gmt < end ? 1 : 0);
  }

datetime SundayWeekUtc(int year, int month, int nth)
  {
   datetime first = StrToTime(StringConcatenate(year, ".", month, ".01"));
   int add = (7 - DowOf(first)) % 7;
   return(first + (add + 7 * (nth - 1)) * 86400);
  }

datetime LastSundayUtc(int year, int month)
  {
   int y = year, m = month + 1;
   if(m > 12)
     {
      m = 1;
      y++;
     }
   datetime next = StrToTime(StringConcatenate(y, ".", m, ".01"));
   int back = (DowOf(next) == 0 ? 7 : DowOf(next));
   return(next - back * 86400);
  }

int NyDayOf(datetime serverEpoch)
  {
   return(DayNumOf(LocalFields(serverEpoch, NyOffsetAt(UtcOf(serverEpoch)))));
  }

// the electronic market day: a bar at or after 18:00 New York belongs to the
// next trade date, exactly like the engine's eth_day
int EthDayOf(datetime serverEpoch)
  {
   datetime local = LocalFields(serverEpoch, NyOffsetAt(UtcOf(serverEpoch)));
   return(DayNumOf(local) + (MinuteOfDay(local) >= 1080 ? 1 : 0));
  }

bool InNyBreak(datetime serverEpoch)   // the 17:00-18:00 New York hour of the feed
  {
   int min = MinuteOfDay(LocalFields(serverEpoch, NyOffsetAt(UtcOf(serverEpoch))));
   return(min >= 1020 && min < 1080);
  }

// the four trading windows of the strategy, each in its own zone
bool WindowAt(int which, datetime serverEpoch)
  {
   datetime ny = LocalFields(serverEpoch, NyOffsetAt(UtcOf(serverEpoch)));
   datetime lon = LocalFields(serverEpoch, LondonOffsetAt(UtcOf(serverEpoch)));
   int nyMin = MinuteOfDay(ny);
   int lonMin = MinuteOfDay(lon);
   bool london = IsWeekday(DowOf(lon)) && lonMin >= 480 && lonMin < 990;
   bool newyork = IsWeekday(DowOf(ny)) && nyMin >= 480 && nyMin < 1020;
   bool cash = IsWeekday(DowOf(ny)) && nyMin >= 570 && nyMin < 960;

   if(which == 0)
      return(london);
   if(which == 1)
      return(newyork);
   if(which == 2)
      return(cash);
   return(london || newyork);
  }

bool SessionOpen(datetime serverEpoch)
  {
   return(WindowAt((int)InpSession, serverEpoch));
  }

bool ResolveServerOffset()
  {
   if(InpServerGmtOffset != -99)
     {
      if(InpServerGmtOffset < -13 || InpServerGmtOffset > 14)
        {
         Log("InpServerGmtOffset must be between -13 and 14 hours");
         return(false);
        }
      g_serverOffH = InpServerGmtOffset;
      return(true);
     }
   if(IsTesting())
     {
      Log("the strategy tester has no GMT clock. Set InpServerGmtOffset to the server offset in" +
          " hours (2 or 3 for a Central European broker, 0 if the server is UTC).");
      return(false);
     }
   double hours = (double)(TimeCurrent() - TimeGMT()) / 3600.0;
   int detected = (int)MathRound(hours);
   if(detected < -13 || detected > 14)
     {
      Log("server offset detection gave " + DoubleToString(hours, 2) + " hours; set InpServerGmtOffset");
      return(false);
     }
   g_serverOffH = detected;
   Log("detected server offset UTC" + (detected >= 0 ? "+" : "") + IntegerToString(detected) +
       " from the PC clock. If the broker moves its offset with daylight saving, set the input yourself.");
   return(true);
  }

//+------------------------------------------------------------------+
//| level candles and records                                        |
//+------------------------------------------------------------------+
int TFMinutesOf(int tf)
  {
   switch(tf)
     {
      case PERIOD_M1:   return(1);
      case PERIOD_M5:   return(5);
      case PERIOD_M15:  return(15);
      case PERIOD_M30:  return(30);
      case PERIOD_H1:   return(60);
      case PERIOD_H2:   return(120);
      case PERIOD_H4:   return(240);
      case PERIOD_D1:   return(1440);
     }
   return(-1);
  }

string TFText(int tf)
  {
   int m = TFMinutesOf(tf);
   if(m < 0)
      return("bad");
   if(m == 1440)
      return("D1");
   if(m >= 60)
      return(IntegerToString(m / 60) + "H");
   return(IntegerToString(m) + "M");
  }

int PeriodFromMinutes(int minutes)
  {
   if(minutes == 1)    return(PERIOD_M1);
   if(minutes == 5)    return(PERIOD_M5);
   if(minutes == 15)   return(PERIOD_M15);
   if(minutes == 30)   return(PERIOD_M30);
   if(minutes == 60)   return(PERIOD_H1);
   if(minutes == 120)  return(PERIOD_H2);
   if(minutes == 240)  return(PERIOD_H4);
   if(minutes == 1440) return(PERIOD_D1);
   Log("InpLevelBarMinutes " + IntegerToString(minutes) + " is not a MT4 bar size, using the auto source");
   return(-1);
  }

int LevelBarTF()
  {
   if(InpLevelBarMinutes > 0)
     {
      int tf = PeriodFromMinutes(InpLevelBarMinutes);
      if(tf > 0)
         return(tf);
     }
   if(InpLevelSession == LEVELS_RTH)
      return(PERIOD_M30);              // the 09:30 cash open needs half-hour bars
   return(PERIOD_H1);                  // 18:00 New York always lands on an hour
  }

// which candle a bar belongs to, and whether the level session keeps it
void BarPlacement(datetime serverEpoch, int &dayKey, bool &keep)
  {
   if(InpLevelSession == LEVELS_RTH)
     {
      dayKey = NyDayOf(serverEpoch);
      keep = WindowAt(2, serverEpoch);
      return;
     }
   dayKey = EthDayOf(serverEpoch);
   keep = true;
   if(InpLevelSession == LEVELS_ETH)
      keep = !InNyBreak(serverEpoch);
  }

// Only the open and the close of a candle become levels, so a source bar of
// one hour or less reproduces the engine's minute aggregation exactly.
bool BuildLevels(int historyDays)
  {
   int srcBars = iBars(Symbol(), (ENUM_TIMEFRAMES)g_srcTF);
   if(srcBars < 50)
     {
      Log("the terminal only has " + IntegerToString(srcBars) + " " + TFText(g_srcTF) +
          " bars for this symbol. Open a chart of the symbol, load more history, or lower" +
          " InpLevelHistoryDays.");
      return(false);
     }
   datetime from = TimeCurrent() - historyDays * 86400;
   int startShift = iBarShift(Symbol(), (ENUM_TIMEFRAMES)g_srcTF, from, false);
   if(startShift < 0 || startShift > srcBars - 1)
      startShift = srcBars - 1;

   ArrayResize(g_dcDay, 0);
   ArrayResize(g_dcOpen, 0);
   ArrayResize(g_dcClose, 0);

   int curDay = -2147483647;
   double curOpen = 0.0, curClose = 0.0;
   bool haveCandle = false;
   int used = 0;

   for(int sh = startShift; sh >= 0; sh--)
     {
      datetime bt = iTime(Symbol(), (ENUM_TIMEFRAMES)g_srcTF, sh);
      if(bt == 0)
         continue;
      bool keep;
      int key;
      BarPlacement(bt, key, keep);
      if(!keep)
         continue;
      double o = iOpen(Symbol(), (ENUM_TIMEFRAMES)g_srcTF, sh);
      double c = iClose(Symbol(), (ENUM_TIMEFRAMES)g_srcTF, sh);
      if(o <= 0.0 || c <= 0.0)
         continue;
      used++;
      if(!haveCandle || key != curDay)
        {
         if(haveCandle)
            AddDailyCandle(curDay, curOpen, curClose);
         curDay = key;
         curOpen = o;
         haveCandle = true;
        }
      curClose = c;
     }
   if(haveCandle)
     {
      AddDailyCandle(curDay, curOpen, curClose);
      g_liveDay = curDay;
      g_liveOpen = curOpen;
      g_liveClose = curClose;
     }
   if(used < 10)
     {
      Log("only " + IntegerToString(used) + " bars fall inside the level session. Check" +
          " InpLevelSession and InpLevelBarMinutes.");
      return(false);
     }
   BuildRecords();
   int nd = ArraySize(g_dcDay);
   Log("candles " + IntegerToString(nd) + ": " + CandleText(0) + " .. " + CandleText(nd - 1) +
       " (the last one is still forming)");
   return(true);
  }

string CandleText(int index)
  {
   int n = ArraySize(g_dcDay);
   if(index < 0 || index >= n)
      return("-");
   return(DayText(g_dcDay[index]) + " o" + DoubleToStr(g_dcOpen[index], g_decimals) +
          " c" + DoubleToStr(g_dcClose[index], g_decimals));
  }

void AddDailyCandle(int day, double openPrice, double closePrice)
  {
   int n = ArraySize(g_dcDay);
   if(n > 0 && g_dcDay[n - 1] == day)
     {
      g_dcClose[n - 1] = closePrice;
      return;
     }
   ArrayResize(g_dcDay, n + 1);
   ArrayResize(g_dcOpen, n + 1);
   ArrayResize(g_dcClose, n + 1);
   g_dcDay[n] = day;
   g_dcOpen[n] = openPrice;
   g_dcClose[n] = closePrice;
  }

void UpdateLiveCandle()
  {
   if(Bid <= 0.0)
      return;
   bool keep;
   int key;
   BarPlacement(TimeCurrent(), key, keep);
   if(!keep)
      return;

   if(key != g_liveDay)
     {
      if(g_liveDay == -1)
        {
         g_liveDay = key;
         g_liveOpen = Bid;
         g_liveClose = Bid;
         return;
        }
      AddDailyCandle(g_liveDay, g_liveOpen, g_liveClose);
      g_liveDay = key;
      g_liveOpen = Bid;
      g_liveClose = Bid;
      BuildRecords();
      g_bkDayBuilt = -1;
      return;
     }
   if(MathAbs(g_liveClose - Bid) < Point / 2.0)
      return;
   int n = ArraySize(g_dcDay) - 1;
   if(n >= 0 && g_dcDay[n] == (int)g_liveDay)
      g_dcClose[n] = Bid;
   g_liveClose = Bid;
  }

void RecAdd(int ready, int price, int day, int kind)
  {
   // the reserved gap keeps appending cheap: a long history adds records one at
   // a time and a plain resize would move the whole array each time
   int n = ArraySize(g_recReady);
   ArrayResize(g_recReady, n + 1, 512);
   ArrayResize(g_recPrice, n + 1, 512);
   ArrayResize(g_recDay, n + 1, 512);
   ArrayResize(g_recKind, n + 1, 512);
   g_recReady[n] = ready;
   g_recPrice[n] = price;
   g_recDay[n] = day;
   g_recKind[n] = kind;
  }

// A candle becomes a level on the next trade day that exists in the data, and
// a week on the first trade day after its last candle.  The candle still
// forming produces no record, and neither does a week that is still open: the
// group must be followed by a candle of a later week, so a mid-week price is
// never traded as a weekly level.
void BuildRecords()
  {
   ArrayResize(g_recReady, 0);
   ArrayResize(g_recPrice, 0);
   ArrayResize(g_recDay, 0);
   ArrayResize(g_recKind, 0);

   int nd = ArraySize(g_dcDay);
   int last = nd - 1;
   for(int i = 0; i < last; i++)
     {
      int ready = g_dcDay[i + 1];
      RecAdd(ready, ToStep(g_dcOpen[i]),  g_dcDay[i], 1);
      RecAdd(ready, ToStep(g_dcClose[i]), g_dcDay[i], 1);
     }

   int i = 0;
   while(i < nd)
     {
      int week = SundayOf(g_dcDay[i]);
      int j = i;
      while(j + 1 < nd && SundayOf(g_dcDay[j + 1]) == week)
         j++;
      if(j < last)
        {
         int lastDay = g_dcDay[j];
         int ready = g_dcDay[j + 1];
         RecAdd(ready, ToStep(g_dcOpen[i]),  lastDay, 2);
         RecAdd(ready, ToStep(g_dcClose[j]), lastDay, 2);
        }
      i = j + 1;
     }
  }

//+------------------------------------------------------------------+
//| the book of one trade day: one row per price, kinds merged, the   |
//| newest candle deciding how old the level is                       |
//+------------------------------------------------------------------+
// Every ready record of the day is packed into one sortable number (price, then
// candle day, then kind), sorted, and merged.  A day needs one pass, so the
// book costs nothing on a long history.
void BuildBook(int day)
  {
   if(g_bkDayBuilt == day && ArraySize(g_bkPrice) > 0)
      return;
   int n = ArraySize(g_recReady);
   ArrayResize(g_pack, n);
   int m = 0;
   for(int i = 0; i < n; i++)
     {
      if(g_recReady[i] > day)
         continue;
      g_pack[m] = ((double)g_recPrice[i] * LR_PACK_DAY + (double)g_recDay[i]) * 4.0 + (double)g_recKind[i];
      m++;
     }
   if(m < n)
      ArrayResize(g_pack, m);
   ArraySort(g_pack);
   ArrayResize(g_bkPrice, 0);
   ArrayResize(g_bkDay, 0);
   ArrayResize(g_bkKind, 0);
   int count = 0;
   int lastPrice = -1;
   for(int i = 0; i < m; i++)
     {
      int price = (int)MathFloor(g_pack[i] / LR_PACK);
      double rest = g_pack[i] - (double)price * LR_PACK;
      int candleDay = (int)MathFloor(rest / 4.0);
      int kind = (int)MathRound(rest - (double)candleDay * 4.0);
      if(price != lastPrice)
        {
         lastPrice = price;
         count++;
         ArrayResize(g_bkPrice, count, 512);
         ArrayResize(g_bkDay, count, 512);
         ArrayResize(g_bkKind, count, 512);
         g_bkPrice[count - 1] = price;
         g_bkDay[count - 1] = candleDay;
         g_bkKind[count - 1] = kind;
        }
      else
        {
         g_bkKind[count - 1] = g_bkKind[count - 1] | kind;
         if(candleDay > g_bkDay[count - 1])
            g_bkDay[count - 1] = candleDay;
        }
     }
   ArrayResize(g_pack, 0);
   g_bkDayBuilt = day;
  }

int FindPrice(int price)
  {
   int n = ArraySize(g_bkPrice);
   int lo = 0, hi = n - 1;
   while(lo <= hi)
     {
      int mid = (lo + hi) / 2;
      if(g_bkPrice[mid] == price)
         return(mid);
      if(g_bkPrice[mid] < price)
         lo = mid + 1;
      else
         hi = mid - 1;
     }
   return(-1);
  }

int LowerBound(int price)
  {
   int n = ArraySize(g_bkPrice);
   int lo = 0, hi = n;
   while(lo < hi)
     {
      int mid = (lo + hi) / 2;
      if(g_bkPrice[mid] < price)
         lo = mid + 1;
      else
         hi = mid;
     }
   return(lo);
  }

int KindOfLevel(int priceStep)
  {
   int pos = FindPrice(priceStep);
   if(pos < 0)
      return(0);
   return(g_bkKind[pos]);
  }

string LevelKind(int priceStep)
  {
   int kind = KindOfLevel(priceStep);
   if(kind == 3)
      return("daily+weekly");
   if(kind == 2)
      return("weekly");
   if(kind == 1)
      return("daily");
   return("level");
  }

bool LevelEligible(int index, int askStep, int bidStep)
  {
   int price = g_bkPrice[index];
   if(g_lookDays > 0 && g_day - g_bkDay[index] > g_lookDays)
      return(false);
   if(TouchedToday(price))
      return(false);
   int nearAsk = price - askStep;
   int nearBid = price - bidStep;
   if(nearAsk < 0)
      nearAsk = -nearAsk;
   if(nearBid < 0)
      nearBid = -nearBid;
   if(nearAsk > g_bandStep && nearBid > g_bandStep)
      return(false);
   return(true);
  }

//+------------------------------------------------------------------+
//| placement                                                        |
//+------------------------------------------------------------------+
int PendingCap(int requested)
  {
   if(InpTradesPerDay != TPD_EVERY)
      return(1);                     // one position at a time needs one stop a side
   if(requested <= 0)
      return(1);
   return(requested);
  }

void Arm()
  {
   if(g_capped)
      return;
   if(InpTradesPerDay == TPD_ONE && g_oneDone)
      return;
   if(InpMaxDailyTrades > 0 && g_dayTrades >= InpMaxDailyTrades)
      return;
   if(InpTradesPerDay != TPD_EVERY && AnyPositionOpen())
      return;                        // the engine blocks entries until the exit
   if(g_lastArm > 0 && TimeCurrent() < g_lastArm + InpArmSeconds)
      return;

   RefreshRates();
   if(Bid <= 0.0 || Ask <= 0.0)
      return;
   double liveSpreadPoints = (Ask - Bid) / g_pricePerPoint;
   if(InpMaxSpreadPoints > 0.0 && liveSpreadPoints > InpMaxSpreadPoints)
      return;

   // the live orders are the truth: recount before deciding what is missing
   g_armBuy = CountPendings(OP_BUYSTOP);
   g_armSell = CountPendings(OP_SELLSTOP);
   g_lastArm = TimeCurrent();

   int n = ArraySize(g_bkPrice);
   if(n == 0)
      return;
   int askStep = ToStep(Ask);
   int bidStep = ToStep(Bid);
   int midStep = (askStep + bidStep) / 2;

   // work outward from the market: a level above can only be a buy trigger, a
   // level below only a sell trigger, and the reachable ones come first
   int hi = LowerBound(midStep);
   int lo = hi - 1;
   int placed = 0;

   while((g_armBuy < g_capBuy || g_armSell < g_capSell) && (lo >= 0 || hi < n))
     {
      int dHi = (hi < n ? g_bkPrice[hi] - midStep : LR_BIG);
      int dLo = (lo >= 0 ? midStep - g_bkPrice[lo] : LR_BIG);
      int dMin = (dHi <= dLo ? dHi : dLo);
      if(dMin > g_bandStep)
         break;
      if(dHi <= dLo)
        {
         if(g_armBuy < g_capBuy && TryArm(hi, askStep, OP_BUYSTOP))
            placed++;
         hi++;
        }
      else
        {
         if(g_armSell < g_capSell && TryArm(lo, bidStep, OP_SELLSTOP))
            placed++;
         lo--;
        }
     }
   if(placed > 0)
      SaveDailyState();
  }

bool TryArm(int index, int marketStep, int cmd)
  {
   if(index < 0 || index >= ArraySize(g_bkPrice))
      return(false);
   int price = g_bkPrice[index];
   if(!LevelEligible(index, ToStep(Ask), ToStep(Bid)))
      return(false);

   int need = g_gapStep + g_spreadStep;
   if(cmd == OP_BUYSTOP)
     {
      if(price - marketStep < need)
         return(false);
      if(PendingExists(price, OP_BUYSTOP) || PositionHoldsLevel(price, 1))
         return(false);
      if(SendStop(cmd, price) > 0)
        {
         g_armBuy++;
         return(true);
        }
      return(false);
     }
   if(marketStep - price < need)
      return(false);
   if(PendingExists(price, OP_SELLSTOP) || PositionHoldsLevel(price, -1))
      return(false);
   if(SendStop(cmd, price) > 0)
     {
      g_armSell++;
      return(true);
     }
   return(false);
  }

int SendStop(int cmd, int priceStep)
  {
   double price = NormalizeDouble(StepToPrice(priceStep), Digits);
   for(int attempt = 0; attempt < 4; attempt++)
     {
      if(!IsTradeAllowed() && !IsTesting())
        {
         Sleep(300);
         RefreshRates();
         continue;
        }
      RefreshRates();
      ResetLastError();
      int ticket = OrderSend(Symbol(), cmd, TradeLots(), price, InpSlippagePoints, 0, 0,
                             StopComment(cmd, priceStep), InpMagic, 0,
                             cmd == OP_BUYSTOP ? clrDodgerBlue : clrTomato);
      if(ticket > 0)
         return(ticket);
      int err = GetLastError();
      if(err == 4 || err == 137 || err == 146 || err == 147)
        {
         Sleep(400);
         continue;
        }
      Log("could not place " + OrderText(cmd) + " at " + DoubleToStr(price, g_decimals) +
          ", error " + IntegerToString(err) +
          (err == 130 ? " (invalid stops: this broker needs the stop further from the market, see the README)" : "") +
          (err == 4756 ? " (trading is not allowed for this EA)" : "") +
          (err == 134 ? " (not enough margin for another stop)" : ""));
      return(-1);
     }
   return(-1);
  }

double TradeLots()
  {
   double step = MarketInfo(Symbol(), MODE_LOTSTEP);
   double minLot = MarketInfo(Symbol(), MODE_MINLOT);
   double maxLot = MarketInfo(Symbol(), MODE_MAXLOT);
   double lots = InpLots;
   int lotDigits = 2;
   if(step > 0.0)
     {
      lots = MathFloor(lots / step + 0.0000001) * step;
      lotDigits = (int)MathCeil(-MathLog10(step));   // a 0.001 step needs 3 digits
      if(lotDigits < 0)
         lotDigits = 0;
      if(lotDigits > 8)
         lotDigits = 8;
     }
   if(minLot > 0.0 && lots < minLot)
      lots = minLot;
   if(maxLot > 0.0 && lots > maxLot)
      lots = maxLot;
   return(NormalizeDouble(lots, lotDigits));
  }

// the level travels in the comment, so a restart still knows what price a live
// order belongs to
string StopComment(int cmd, int priceStep)
  {
   return(StringConcatenate(InpTag, (cmd == OP_BUYSTOP ? "B#" : "S#"), priceStep));
  }

int LevelOfComment(string cmt)
  {
   int at = StringFind(cmt, "#");
   if(at < 0)
      return(-1);
   int step = ParseInt(StringSubstr(cmt, at + 1));
   if(step <= 0)
      return(-1);
   return(step);
  }

// MQL4 has no string to integer function, so digits are read one at a time and
// the first non digit ends the number.
int ParseInt(string s)
  {
   string digits = "0123456789";
   int value = 0;
   int len = StringLen(s);
   for(int i = 0; i < len; i++)
     {
      int d = StringFind(digits, StringSubstr(s, i, 1));
      if(d < 0)
         break;
      value = value * 10 + d;
     }
   return(value);
  }

void PruneArmed()
  {
   RefreshRates();
   if(Bid <= 0.0)
      return;
   int askStep = ToStep(Ask);
   int bidStep = ToStep(Bid);
   for(int p = OrdersTotal() - 1; p >= 0; p--)
     {
      if(!OrderSelect(p, SELECT_BY_POS, MODE_TRADES))
         continue;
      if(OrderMagicNumber() != InpMagic || OrderSymbol() != Symbol())
         continue;
      int cmd = OrderType();
      if(cmd != OP_BUYSTOP && cmd != OP_SELLSTOP)
         continue;
      int price = ToStep(OrderOpenPrice());
      int distance = (cmd == OP_BUYSTOP ? price - askStep : bidStep - price);
      int level = LevelOfComment(OrderComment());
      bool spent = (level > 0 && TouchedToday(level));
      if(distance > g_bandStep || spent)
        {
         DeleteOrder(OrderTicket());
         if(cmd == OP_BUYSTOP)
            g_armBuy = MathMax(0, g_armBuy - 1);
         else
            g_armSell = MathMax(0, g_armSell - 1);
        }
     }
  }

void DeleteAllPendings()
  {
   for(int p = OrdersTotal() - 1; p >= 0; p--)
     {
      if(!OrderSelect(p, SELECT_BY_POS, MODE_TRADES))
         continue;
      if(OrderMagicNumber() != InpMagic || OrderSymbol() != Symbol())
         continue;
      int cmd = OrderType();
      if(cmd == OP_BUYSTOP || cmd == OP_SELLSTOP || cmd == OP_BUYLIMIT || cmd == OP_SELLLIMIT)
         DeleteOrder(OrderTicket());
     }
   g_armBuy = 0;
   g_armSell = 0;
  }

void DeleteOrder(int ticket)
  {
   for(int attempt = 0; attempt < 4; attempt++)
     {
      if(!OrderSelect(ticket, SELECT_BY_TICKET))
         return;
      if(OrderType() <= OP_SELL)
         return;
      ResetLastError();
      if(OrderDelete(ticket))
         return;
      int err = GetLastError();
      if(err == 4 || err == 137 || err == 146)
        {
         Sleep(300);
         continue;
        }
      Log("OrderDelete " + IntegerToString(ticket) + " failed, error " + IntegerToString(err));
      return;
     }
  }

bool PendingExists(int priceStep, int cmd)
  {
   for(int p = 0; p < OrdersTotal(); p++)
     {
      if(!OrderSelect(p, SELECT_BY_POS, MODE_TRADES))
         continue;
      if(OrderMagicNumber() != InpMagic || OrderSymbol() != Symbol())
         continue;
      if(OrderType() != cmd)
         continue;
      if(ToStep(OrderOpenPrice()) == priceStep)
         return(true);
     }
   return(false);
  }

bool PositionHoldsLevel(int priceStep, int side)
  {
   for(int i = 0; i < LR_SLOTS; i++)
     {
      if(g_trkTicket[i] == 0)
         continue;
      if(g_trkSide[i] != side)
         continue;
      if(g_trkLevel[i] == priceStep)
         return(true);
     }
   return(false);
  }

bool AnyPositionOpen()
  {
   for(int p = 0; p < OrdersTotal(); p++)
     {
      if(!OrderSelect(p, SELECT_BY_POS, MODE_TRADES))
         continue;
      if(OrderMagicNumber() != InpMagic || OrderSymbol() != Symbol())
         continue;
      int cmd = OrderType();
      if(cmd == OP_BUY || cmd == OP_SELL)
         return(true);
     }
   return(false);
  }

int CountPendings(int cmd)
  {
   int n = 0;
   for(int p = 0; p < OrdersTotal(); p++)
     {
      if(!OrderSelect(p, SELECT_BY_POS, MODE_TRADES))
         continue;
      if(OrderMagicNumber() != InpMagic || OrderSymbol() != Symbol())
         continue;
      if(OrderType() == cmd)
         n++;
     }
   return(n);
  }

// After a restart the live orders are the truth: rebuild the counters, the
// tracked positions and the levels already spent today from them.
void ReconcileBroker()
  {
   for(int i = 0; i < LR_SLOTS; i++)
     {
      g_trkTicket[i] = 0;
      g_trkSide[i] = 0;
      g_trkValue[i] = 0;
      g_trkLevel[i] = 0;
      g_trkDay[i] = 0;
      g_trkLots[i] = 0.0;
     }
   g_armBuy = CountPendings(OP_BUYSTOP);
   g_armSell = CountPendings(OP_SELLSTOP);

   for(int p = 0; p < OrdersTotal(); p++)
     {
      if(!OrderSelect(p, SELECT_BY_POS, MODE_TRADES))
         continue;
      if(OrderMagicNumber() != InpMagic || OrderSymbol() != Symbol())
         continue;
      int cmd = OrderType();
      if(cmd != OP_BUY && cmd != OP_SELL)
         continue;
      int level = LevelOfComment(OrderComment());
      int value = ToStep(OrderOpenPrice());
      if(level < 0)
         level = value;
      int side = (cmd == OP_BUY ? 1 : -1);
      int entryDay = NyDayOf(OrderOpenTime());
      TrackAdd(OrderTicket(), side, value, level, entryDay, OrderLots());
      // the state file already counted the levels of today, so a restart must
      // not add them a second time
      if(entryDay == g_day && !TouchedToday(level))
        {
         g_dayTrades++;
         TradedAdd(level);
        }
     }
   if(g_dayTrades > 0)
      Log("adopted " + IntegerToString(g_dayTrades) + " trade(s) of today");
  }

//+------------------------------------------------------------------+
//| fills and exits                                                  |
//+------------------------------------------------------------------+
void TrackPositions()
  {
   for(int p = OrdersTotal() - 1; p >= 0; p--)
     {
      if(!OrderSelect(p, SELECT_BY_POS, MODE_TRADES))
         continue;
      if(OrderMagicNumber() != InpMagic || OrderSymbol() != Symbol())
         continue;
      int cmd = OrderType();
      if(cmd != OP_BUY && cmd != OP_SELL)
         continue;
      int ticket = OrderTicket();
      if(IndexOfTicket(ticket) >= 0)
         continue;
      int side = (cmd == OP_BUY ? 1 : -1);
      int value = ToStep(OrderOpenPrice());    // valued at the price actually paid
      int level = LevelOfComment(OrderComment());
      if(level < 0)
         level = value;
      TrackAdd(ticket, side, value, level, NyDayOf(OrderOpenTime()), OrderLots());
      g_dayTrades++;
      if(!TouchedToday(level))
         TradedAdd(level);
      Log("filled " + OrderText(cmd) + " " + IntegerToString(ticket) + " at " +
          DoubleToStr(OrderOpenPrice(), g_decimals) + ", " + LevelKind(level) + " level " +
          DoubleToStr(StepToPrice(level), g_decimals) +
          (value != level ? " (off the level by " + DoubleToStr((double)(value - level) / g_stepsPerPoint, 1) + " pts)" : "") +
          ", day points " + DoubleToStr((double)g_dayPnlStep / g_stepsPerPoint, 1));
      if(InpTradesPerDay == TPD_ONE)
         g_oneDone = true;
      if(InpTradesPerDay != TPD_EVERY)
         DeleteAllPendings();                  // no second entry until this one is out
      else
         DropPendingAtLevel(level);
      SaveDailyState();
     }

   for(int i = 0; i < LR_SLOTS; i++)
     {
      if(g_trkTicket[i] == 0 || TrackedAlive(g_trkTicket[i]))
         continue;
      int ticket = g_trkTicket[i];
      int side = g_trkSide[i];
      int value = g_trkValue[i];
      int level = g_trkLevel[i];
      int entryDay = g_trkDay[i];
      double lots = g_trkLots[i];
      TrackDrop(ticket);

      if(!OrderSelect(ticket, SELECT_BY_TICKET, MODE_HISTORY))
        {
         Log("trade " + IntegerToString(ticket) + " left the open list but is not in the account" +
             " history. Widen the Account History period, otherwise the daily target counter and" +
             " the money total lose trades.");
         continue;
        }
      // MT4 records the close of a sell at the ask, so put it back on the bid
      // the engine walks before counting points.
      int closeStep = ToStep(OrderClosePrice());
      if(side < 0)
         closeStep = closeStep - LiveSpreadStep();
      int pnlStep = side * (closeStep - value);
      double money = OrderProfit() + OrderSwap() + OrderCommission();
      int closeDay = NyDayOf(OrderCloseTime());
      string why = OrderComment();

      g_closed++;
      if(pnlStep > 0)
         g_closedWins++;
      g_moneyTotal += money;
      if(closeDay == entryDay && entryDay == g_day)
        {
         g_dayPnlStep += pnlStep;
         g_dayMoney += money;
         g_dayClosed++;
         if(InpTradesPerDay == TPD_UNTIL && g_dayPnlStep >= g_targetStep)
            g_capped = true;
        }
      if(InpWriteCsvLog)
         LogCsv(ticket, side, lots, level, value, closeStep, pnlStep, money, OrderCloseTime(), why);
      Log("closed " + OrderText(side > 0 ? OP_BUY : OP_SELL) + " " + IntegerToString(ticket) +
          " at " + DoubleToStr(StepToPrice(closeStep), g_decimals) + " = " +
          DoubleToStr((double)pnlStep / g_stepsPerPoint, 1) + " pts, " + DoubleToStr(money, 2) +
          " (today " + DoubleToStr((double)g_dayPnlStep / g_stepsPerPoint, 1) + " pts / " +
          DoubleToStr(g_dayMoney, 2) + ")");
      g_lastArm = 0;
      SaveDailyState();
     }
  }

int LiveSpreadStep()
  {
   RefreshRates();
   if(Ask <= 0.0 || Bid <= 0.0)
      return(g_spreadStep);
   int live = (int)MathRound((Ask - Bid) * g_stepScale);
   if(live <= 0)
      return(g_spreadStep);
   return(live);
  }

void DropPendingAtLevel(int priceStep)
  {
   for(int p = OrdersTotal() - 1; p >= 0; p--)
     {
      if(!OrderSelect(p, SELECT_BY_POS, MODE_TRADES))
         continue;
      if(OrderMagicNumber() != InpMagic || OrderSymbol() != Symbol())
         continue;
      int cmd = OrderType();
      if(cmd != OP_BUYSTOP && cmd != OP_SELLSTOP)
         continue;
      int level = LevelOfComment(OrderComment());
      if((level > 0 && level == priceStep) || ToStep(OrderOpenPrice()) == priceStep)
        {
         DeleteOrder(OrderTicket());
         if(cmd == OP_BUYSTOP)
            g_armBuy = MathMax(0, g_armBuy - 1);
         else
            g_armSell = MathMax(0, g_armSell - 1);
        }
     }
  }

// Stop and target go on the order once, anchored to the price actually paid.
// MT4 closes a long at the bid, so the engine's bid levels are exactly what the
// broker needs.  It closes a short at the ask, so a short's levels move out by
// the live spread to fire on the same bid.
void ApplyStops()
  {
   if(InpExitMode != EXIT_BROKER_STOPS)
      return;
   RefreshRates();
   for(int i = 0; i < LR_SLOTS; i++)
     {
      if(g_trkTicket[i] == 0)
         continue;
      if(!OrderSelect(g_trkTicket[i], SELECT_BY_TICKET))
         continue;
      if(OrderType() > OP_SELL)
         continue;
      if(OrderStopLoss() > 0.0 || OrderTakeProfit() > 0.0)
         continue;
      int side = g_trkSide[i];
      int value = g_trkValue[i];
      int shift = (side < 0 && InpAdjustShortStops ? LiveSpreadStep() : 0);
      int slStep, tpStep;
      if(side > 0)
        {
         slStep = value - g_stopStep;
         tpStep = value + g_targetStep;
        }
      else
        {
         slStep = value + g_stopStep + shift;
         tpStep = value - g_targetStep + shift;
        }
      double sl = NormalizeDouble(StepToPrice(slStep), Digits);
      double tp = NormalizeDouble(StepToPrice(tpStep), Digits);
      ResetLastError();
      if(!OrderModify(OrderTicket(), OrderOpenPrice(), sl, tp, 0, clrGoldenrod))
        {
         int err = GetLastError();
         if(err != 1)
            Log("OrderModify " + IntegerToString(OrderTicket()) + " failed, error " + IntegerToString(err) +
                " (130 = the stop distance is smaller than the broker allows)");
         continue;
        }
      Log("stops on " + IntegerToString(OrderTicket()) + ": sl " + DoubleToStr(sl, g_decimals) +
          " tp " + DoubleToStr(tp, g_decimals) +
          (side < 0 && InpAdjustShortStops ? " (bid levels plus the live spread)" : ""));
     }
  }

void MonitorBidExits()
  {
   int bidStep = ToStep(Bid);
   for(int i = 0; i < LR_SLOTS; i++)
     {
      if(g_trkTicket[i] == 0)
         continue;
      int side = g_trkSide[i];
      int value = g_trkValue[i];
      bool hitStop = (side > 0 ? bidStep <= value - g_stopStep : bidStep >= value + g_stopStep);
      bool hitTarget = (side > 0 ? bidStep >= value + g_targetStep : bidStep <= value - g_targetStep);
      if(!hitStop && !hitTarget)
         continue;
      ClosePosition(g_trkTicket[i], hitStop ? "stop" : "target");
     }
  }

void CloseAllPositions(string reason)
  {
   for(int i = 0; i < LR_SLOTS; i++)
      if(g_trkTicket[i] != 0)
         ClosePosition(g_trkTicket[i], reason);
  }

void ClosePosition(int ticket, string reason)
  {
   for(int attempt = 0; attempt < 5; attempt++)
     {
      if(!OrderSelect(ticket, SELECT_BY_TICKET))
         return;
      if(OrderType() > OP_SELL)
         return;
      RefreshRates();
      double price = (OrderType() == OP_BUY ? Bid : Ask);
      ResetLastError();
      if(OrderClose(ticket, OrderLots(), NormalizeDouble(price, Digits), InpSlippagePoints, clrGray))
        {
         Log("closed " + IntegerToString(ticket) + " at market (" + reason + ")");
         return;
        }
      int err = GetLastError();
      if(err == 4 || err == 137 || err == 146)
        {
         Sleep(400);
         continue;
        }
      Log("OrderClose " + IntegerToString(ticket) + " failed, error " + IntegerToString(err));
      return;
     }
  }

// Gates that are not driven by a fresh order: the day cap, one-a-day, the
// manual close of a trade and a position that outlived its own session.
void EnforceGates()
  {
   if(!SessionOpen(TimeCurrent()))
      return;
   if(CountPendings(OP_BUYSTOP) + CountPendings(OP_SELLSTOP) == 0)
      return;
   bool blocked = g_capped
                  || (InpTradesPerDay == TPD_ONE && g_oneDone)
                  || (InpMaxDailyTrades > 0 && g_dayTrades >= InpMaxDailyTrades)
                  || (InpTradesPerDay != TPD_EVERY && AnyPositionOpen());
   if(blocked)
      {
       DeleteAllPendings();
       if(g_capped)
          Log("day target reached (" + DoubleToStr((double)g_dayPnlStep / g_stepsPerPoint, 1) +
              " points), no more entries today");
      }
  }

//+------------------------------------------------------------------+
//| tracked order slots                                              |
//+------------------------------------------------------------------+
void TrackAdd(int ticket, int side, int value, int level, int day, double lots)
  {
   int free = -1;
   for(int i = 0; i < LR_SLOTS; i++)
     {
      if(g_trkTicket[i] == ticket)
        {
         g_trkLots[i] = lots;
         return;
        }
      if(free < 0 && g_trkTicket[i] == 0)
         free = i;
     }
   if(free < 0)
     {
      Log("all " + IntegerToString(LR_SLOTS) + " tracking slots are used; this trade is not monitored");
      return;
     }
   g_trkTicket[free] = ticket;
   g_trkSide[free] = side;
   g_trkValue[free] = value;
   g_trkLevel[free] = level;
   g_trkDay[free] = day;
   g_trkLots[free] = lots;
  }

void TrackDrop(int ticket)
  {
   for(int i = 0; i < LR_SLOTS; i++)
      if(g_trkTicket[i] == ticket)
        {
         g_trkTicket[i] = 0;
         g_trkSide[i] = 0;
         g_trkValue[i] = 0;
         g_trkLevel[i] = 0;
         g_trkDay[i] = 0;
         g_trkLots[i] = 0.0;
         return;
        }
  }

int IndexOfTicket(int ticket)
  {
   for(int i = 0; i < LR_SLOTS; i++)
      if(g_trkTicket[i] == ticket)
         return(i);
   return(-1);
  }

bool TrackedAlive(int ticket)
  {
   for(int p = 0; p < OrdersTotal(); p++)
     {
      if(!OrderSelect(p, SELECT_BY_POS, MODE_TRADES))
         continue;
      if(OrderTicket() == ticket)
         return(true);
     }
   return(false);
  }

//+------------------------------------------------------------------+
//| daily state in a text file under MQL4\Files, so a restart or a   |
//| VPS reboot does not trade the same level twice on one day.  MT4  |
//| global variables only hold doubles, and FileDelete is forbidden  |
//| in the tester, so the file is append only and the last line wins.|
//+------------------------------------------------------------------+
bool TouchedToday(int priceStep)
  {
   for(int i = 0; i < ArraySize(g_traded); i++)
      if(g_traded[i] == priceStep)
         return(true);
   return(false);
  }

void TradedAdd(int priceStep)
  {
   if(TouchedToday(priceStep))
      return;
   int n = ArraySize(g_traded);
   ArrayResize(g_traded, n + 1);
   g_traded[n] = priceStep;
  }

void ResetDailyState()
  {
   ArrayResize(g_traded, 0);
   g_dayPnlStep = 0;
   g_oneDone = false;
   g_capped = false;
   g_dayTrades = 0;
   g_dayMoney = 0.0;
   g_dayClosed = 0;
   g_lastArm = 0;
  }

void SaveDailyState()
  {
   int n = ArraySize(g_traded);
   string s = IntegerToString(g_day) + ";" + IntegerToString(n);
   for(int i = 0; i < n; i++)
      s = StringConcatenate(s, ";", g_traded[i]);
   s = StringConcatenate(s, ";", g_dayPnlStep, ";", g_oneDone ? 1 : 0, ";", g_dayTrades, "\n");
   int handle = FileOpen(g_stateName, FILE_TXT | FILE_WRITE);
   if(handle < 0)
     {
      Log("the state file could not be opened, error " + IntegerToString(GetLastError()));
      return;
     }
   FileWriteString(handle, s);
   FileClose(handle);
  }

string LastStateLine()
  {
   if(!FileIsExist(g_stateName))
      return("");
   int handle = FileOpen(g_stateName, FILE_TXT | FILE_READ);
   if(handle < 0)
      return("");
   string last = "";
   ulong size = FileSize(handle);
   while(FileTell(handle) < size)
     {
      string line = FileReadString(handle);
      if(StringLen(line) > 3)
         last = line;
     }
   FileClose(handle);
   return(last);
  }

int SplitFields(string s, string &out[])
  {
   int n = 0;
   int from = 0;
   int total = StringLen(s) + 1;
   while(from < total)
     {
      int at = StringFind(s, ";", from);
      int size = (at < 0 ? total - from : at - from);
      ArrayResize(out, n + 1);
      out[n] = StringSubstr(s, from, size);
      n++;
      if(at < 0)
         break;
      from = at + 1;
     }
   return(n);
  }

void LoadDailyState()
  {
   ResetDailyState();
   string s = LastStateLine();
   if(StringLen(s) == 0)
      return;
   string parts[];
   int count = SplitFields(s, parts);
   if(count < 5)
      return;
   if(ParseInt(parts[0]) != g_day)
      return;
   int n = ParseInt(parts[1]);
   for(int i = 0; i < n && 2 + i < count - 3; i++)
      TradedAdd(ParseInt(parts[2 + i]));
   int tail = 2 + n;
   if(tail + 2 >= count)
      return;
   g_dayPnlStep = ParseInt(parts[tail]);
   g_oneDone = (ParseInt(parts[tail + 1]) != 0);
   g_dayTrades = ParseInt(parts[tail + 2]);
   g_capped = (InpTradesPerDay == TPD_UNTIL && g_dayPnlStep >= g_targetStep);
   if(n > 0 || g_dayTrades > 0)
      Log("restored " + DayText(g_day) + ": " + IntegerToString(n) + " levels spent, " +
          IntegerToString(g_dayTrades) + " trades, " +
          DoubleToStr((double)g_dayPnlStep / g_stepsPerPoint, 1) + " points");
  }

//+------------------------------------------------------------------+
//| helpers                                                          |
//+------------------------------------------------------------------+
int ToStep(double price)
  {
   return((int)MathRound(price * g_stepScale));
  }

double StepToPrice(int step)
  {
   return((double)step / g_stepScale);
  }

// One strategy point is 0.10 on gold, 1.00 on US100 and one pip on a currency
// pair, which is the registry in the Python project's config.py.  On a
// fractional-pip FX quote Point is already one pip, so 50 * Point is right; an
// index or metal needs the name, because its point has nothing to do with the
// broker's smallest price step.
double AutoPricePer50()
  {
   string s = Symbol();
   StringToUpper(s);
   if(StringFind(s, "XAU") >= 0 || StringFind(s, "GOLD") >= 0)
      return(5.0);
   if(StringFind(s, "US100") >= 0 || StringFind(s, "NAS100") >= 0 || StringFind(s, "USTEC") >= 0
      || StringFind(s, "NDAQ") >= 0 || StringFind(s, "NASDAQ") >= 0 || StringFind(s, "US500") >= 0
      || s == "NQ" || s == "SPX" || s == "US30")
      return(50.0);
   return(50.0 * Point);
  }

// Candles must start on the session clock, or the daily open of a few candles
// belongs to the wrong market day.  Bars of 60 minutes or less always start on
// a whole hour, and half-hour bars also start at :30.
bool AlignmentOk()
  {
   int minutes = TFMinutesOf(g_srcTF);
   if(minutes < 0)
     {
      Log("unknown level bar size");
      return(false);
     }
   if(minutes > 60)
     {
      Log(IntegerToString(minutes) + " minute candles start at the server midnight or every 2 and 4" +
          " hours from it. The market day opens at 18:00 New York, which is 00:00, 01:00 or 02:00" +
          " server time depending on daylight saving, so those candles would put a few daily opens" +
          " on the wrong day. Use InpLevelBarMinutes 60 (or 30 for the cash session).");
      return(false);
     }
   if(InpLevelSession == LEVELS_RTH && minutes > 30)
     {
      Log("the cash session opens at 09:30 New York, which needs bars of 30 minutes or less." +
          " Set InpLevelBarMinutes to 30.");
      return(false);
     }
   if(minutes != 60 && minutes != 30)
      Log("note: " + TFText(g_srcTF) + " candles work but scan far more bars at start-up than needed.");
   return(true);
  }

string OrderText(int cmd)
  {
   if(cmd == OP_BUYSTOP)
      return("buy stop");
   if(cmd == OP_SELLSTOP)
      return("sell stop");
   if(cmd == OP_BUY)
      return("buy");
   if(cmd == OP_SELL)
      return("sell");
   return("order");
  }

string DayText(int dayNum)
  {
   datetime local = (datetime)dayNum * 86400;
   return(StringConcatenate(TimeYear(local), ".", TimeMonth(local), ".", TimeDay(local)));
  }

string SessionLabel()
  {
   if(InpSession == SESSION_LONDON)
      return("London 08:00-16:30");
   if(InpSession == SESSION_NEWYORK)
      return("New York 08:00-17:00");
   if(InpSession == SESSION_RTH)
      return("New York cash 09:30-16:00");
   return("London or New York");
  }

string LevelLabel()
  {
   if(InpLevelSession == LEVELS_ALL)
      return("all hours");
   if(InpLevelSession == LEVELS_ETH)
      return("ETH 18:00-17:00");
   return("cash 09:30-16:00");
  }

string LookLabel()
  {
   if(InpLookback == LOOK_ALL)
      return("all history");
   return(IntegerToString(g_lookDays) + " days");
  }

string TpdLabel()
  {
   if(InpTradesPerDay == TPD_EVERY)
      return("every level");
   if(InpTradesPerDay == TPD_SERIAL)
      return("one at a time");
   if(InpTradesPerDay == TPD_ONE)
      return("one a day");
   return("until target");
  }

//+------------------------------------------------------------------+
//| journal and panel                                                |
//+------------------------------------------------------------------+
void Log(string msg)
  {
   Print(InpTag, " ", msg);
  }

void LogCsv(int ticket, int side, double lots, int level, int value, int closeStep, int pnlStep,
            double money, datetime closedAt, string why)
  {
   int handle = FileOpen(g_csvName, FILE_CSV | FILE_READ | FILE_WRITE, ",");
   if(handle < 0)
     {
      Log("the trade log could not be opened, error " + IntegerToString(GetLastError()));
      return;
     }
   FileSeek(handle, 0, SEEK_END);
   if(FileSize(handle) == 0)
      FileWrite(handle, "closed_server", "ticket", "side", "lots", "level", "entry", "exit",
                "points", "money", "note");
   FileWrite(handle, TimeToStr(closedAt, TIME_DATE | TIME_MINUTES), IntegerToString(ticket),
             side > 0 ? "buy" : "sell", DoubleToStr(lots, 2),
             DoubleToStr(StepToPrice(level), g_decimals), DoubleToStr(StepToPrice(value), g_decimals),
             DoubleToStr(StepToPrice(closeStep), g_decimals),
             DoubleToStr((double)pnlStep / g_stepsPerPoint, 2), DoubleToStr(money, 2), why);
   FileClose(handle);
  }

void UpdatePanel(bool inSession)
  {
   double liveSpread = (Ask - Bid) / g_pricePerPoint;
   string txt = "";
   txt = StringConcatenate(txt, InpTag, "  ", Symbol(), "   candles ", TFText(g_srcTF),
                           "   NY day ", DayText(g_day), "\n");
   txt = StringConcatenate(txt, "levels: ", LevelLabel(), ", ", LookLabel(), ", ",
                           IntegerToString(ArraySize(g_bkPrice)), " in the book, ",
                           IntegerToString(ArraySize(g_traded)), " spent today\n");
   txt = StringConcatenate(txt, "trade: ", SessionLabel(), (inSession ? "  OPEN" : "  closed"),
                           ", continuation, touch, stop ", IntegerToString(InpStopPoints),
                           " / target ", IntegerToString(InpTargetPoints), " pts, ", TpdLabel(), "\n");
   txt = StringConcatenate(txt, "point = ", DoubleToStr(g_pricePerPoint, g_decimals),
                           ", modelled spread ", DoubleToStr(InpModelSpreadPts, 2),
                           ", live spread ", DoubleToStr(liveSpread, 2),
                           "   server UTC", (g_serverOffH >= 0 ? "+" : ""), IntegerToString(g_serverOffH),
                           ", NY UTC", IntegerToString(NyOffsetAt(GmtNow())), "\n");
   txt = StringConcatenate(txt, "stops open ", IntegerToString(g_armBuy), " buy / ",
                           IntegerToString(g_armSell), " sell",
                           (g_capped ? "   DAY CAPPED" : ""), "\n");
   txt = StringConcatenate(txt, "TODAY   trades ", IntegerToString(g_dayClosed),
                           "   points ", DoubleToStr((double)g_dayPnlStep / g_stepsPerPoint, 1),
                           "   money ", DoubleToStr(g_dayMoney, 2), "\n");
   txt = StringConcatenate(txt, "RUN     closed ", IntegerToString(g_closed), "   win ",
                           DoubleToStr(g_closed > 0 ? 100.0 * g_closedWins / g_closed : 0.0, 1),
                           "%   money ", DoubleToStr(g_moneyTotal, 2), "   equity ",
                           DoubleToStr(AccountEquity(), 2), " (", DoubleToStr(AccountEquity() - g_startEquity, 2),
                           ")\n");
   txt = StringConcatenate(txt, "open:");
   int shown = 0;
   for(int i = 0; i < LR_SLOTS && shown < 5; i++)
     {
      if(g_trkTicket[i] == 0)
         continue;
      double money = 0.0;
      if(OrderSelect(g_trkTicket[i], SELECT_BY_TICKET))
         money = OrderProfit() + OrderSwap() + OrderCommission();
      txt = StringConcatenate(txt, " ", (g_trkSide[i] > 0 ? "L" : "S"), " ",
                              DoubleToStr(StepToPrice(g_trkValue[i]), g_decimals),
                              " lvl ", DoubleToStr(StepToPrice(g_trkLevel[i]), g_decimals),
                              " ", DoubleToStr(money, 2), "   ");
      shown++;
     }
   if(shown == 0)
      txt = StringConcatenate(txt, " none");
   Comment(txt);
  }
//+------------------------------------------------------------------+
