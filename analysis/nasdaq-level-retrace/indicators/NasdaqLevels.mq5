#property copyright "Nasdaq level book"
#property version   "1.00"
#property description "CME daily and weekly open/close levels for the three profitable runs."
#property description "Fade 50/50 sells a cross up and buys a cross down. Continuation does the opposite."
#property description "Lookback is 30, 182, or 365 days from the candle close, or all history."
#property indicator_chart_window
#property indicator_plots 0

enum ENUM_RUN
{
   RUN_FADE_50 = 0,        // Fade 50/50
   RUN_CONT_100_50 = 1,    // Continuation 100/50
   RUN_CONT_100_150 = 2    // Continuation 100/150
};

enum ENUM_LOOK
{
   LOOK_MONTH = 0,    // 1 month
   LOOK_6MONTH = 1,   // 6 months
   LOOK_YEAR = 2,     // 1 year
   LOOK_ALL = 3       // All
};

input group "Strategy"
input ENUM_RUN InpRun = RUN_CONT_100_150; // Run
input double   InpPoint = 1.0;            // Index point (50 points = 50 x this)

input group "Levels"
input ENUM_LOOK InpLook = LOOK_MONTH; // Lookback
input bool      InpDaily = true;      // Daily opens and closes
input bool      InpWeekly = true;     // Weekly opens and closes
input int       InpMaxLines = 80;     // Max lines, nearest to price
input int       InpSide = 3;          // Levels each side in the dashboard
input bool      InpLabels = false;    // Text on the level lines

input group "Clock"
input bool InpBarTimeIsUtc = false; // Bar time is already UTC

struct Candle
{
   bool     building;
   int      key;
   double   op;
   double   cl;
   bool     started;
   datetime lastIn;
   int      savedYmd;
};

struct Level
{
   double   price;
   int      bits;
   datetime ready;
   datetime expire;
   string   src1;
   string   src2;
   int      nsrc;
   int      next;
};

#define HASH 8191

Candle g_day;
Candle g_week;
Level  g_raw[];
int    g_n = 0;
int    g_hash[HASH];
int    g_processed = 0;
bool   g_reset = true;
bool   g_linesDirty = true;

string Prefix()
{
   return "NQLv" + IntegerToString(ChartID());
}

long DaysFromCivil(int y, int m, int d)
{
   if(m <= 2)
      y -= 1;
   long era = (y >= 0 ? y : y - 399) / 400;
   int yoe = (int)(y - era * 400);
   int doy = (153 * (m > 2 ? m - 3 : m + 9) + 2) / 5 + d - 1;
   int doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
   return era * 146097 + doe - 719468;
}

void CivilFromDays(long z, int &y, int &m, int &d)
{
   z += 719468;
   long era = (z >= 0 ? z : z - 146096) / 146097;
   int doe = (int)(z - era * 146097);
   int yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
   y = yoe + (int)(era * 400);
   int doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
   int mp = (5 * doy + 2) / 153;
   d = doy - (153 * mp + 2) / 5 + 1;
   m = (mp < 10 ? mp + 3 : mp - 9);
   if(m <= 2)
      y += 1;
}

int DayOfWeekSun0(int y, int m, int d)
{
   static int t[12] = {0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4};
   int yy = y;
   if(m < 3)
      yy -= 1;
   int dow = (yy + yy / 4 - yy / 100 + yy / 400 + t[m - 1] + d) % 7;
   if(dow < 0)
      dow += 7;
   return dow;
}

int DaysInMonth(int y, int m)
{
   static int dim[13] = {0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31};
   int days = dim[m];
   if(m == 2 && ((y % 4 == 0 && y % 100 != 0) || y % 400 == 0))
      days = 29;
   return days;
}

int NthSunday(int y, int m, int n)
{
   int first = DayOfWeekSun0(y, m, 1);
   return 1 + ((7 - first) % 7) + (n - 1) * 7;
}

int LastSunday(int y, int m)
{
   int day = NthSunday(y, m, 5);
   if(day > DaysInMonth(y, m))
      day -= 7;
   return day;
}

datetime UtcFromParts(int y, int m, int d, int hh, int mm)
{
   return (datetime)(DaysFromCivil(y, m, d) * 86400 + hh * 3600 + mm * 60);
}

void YearOfUtc(datetime utc, int &y)
{
   int m, d;
   CivilFromDays((long)utc / 86400, y, m, d);
}

int ChicagoOffset(datetime utc)
{
   int y;
   YearOfUtc(utc, y);
   datetime start = UtcFromParts(y, 3, NthSunday(y, 3, 2), 8, 0);
   datetime end = UtcFromParts(y, 11, NthSunday(y, 11, 1), 7, 0);
   return (utc >= start && utc < end) ? -5 * 3600 : -6 * 3600;
}

int NyOffset(datetime utc)
{
   int y;
   YearOfUtc(utc, y);
   datetime start = UtcFromParts(y, 3, NthSunday(y, 3, 2), 7, 0);
   datetime end = UtcFromParts(y, 11, NthSunday(y, 11, 1), 6, 0);
   return (utc >= start && utc < end) ? -4 * 3600 : -5 * 3600;
}

int LondonOffset(datetime utc)
{
   int y;
   YearOfUtc(utc, y);
   datetime start = UtcFromParts(y, 3, LastSunday(y, 3), 1, 0);
   datetime end = UtcFromParts(y, 10, LastSunday(y, 10), 0, 0);
   return (utc >= start && utc < end) ? 3600 : 0;
}

void ZoneCivil(datetime utc, int offset, int &y, int &m, int &d, int &mins, int &ymd)
{
   long local = (long)utc + offset;
   long days = local / 86400;
   int sod = (int)(local % 86400);
   if(sod < 0)
   {
      sod += 86400;
      days -= 1;
   }
   CivilFromDays(days, y, m, d);
   mins = sod / 60;
   ymd = y * 10000 + m * 100 + d;
}

void AddDays(int &y, int &m, int &d, int delta)
{
   CivilFromDays(DaysFromCivil(y, m, d) + delta, y, m, d);
}

datetime BarToUtc(datetime barTime)
{
   if(InpBarTimeIsUtc)
      return barTime;
   return barTime - (TimeTradeServer() - TimeGMT());
}

int LookDays()
{
   if(InpLook == LOOK_MONTH)
      return 30;
   if(InpLook == LOOK_6MONTH)
      return 182;
   if(InpLook == LOOK_YEAR)
      return 365;
   return 0;
}

bool IsFade()
{
   return InpRun == RUN_FADE_50;
}

double SlPts()
{
   return IsFade() ? 50.0 : 100.0;
}

double TpPts()
{
   return InpRun == RUN_CONT_100_150 ? 150.0 : 50.0;
}

int UpSide()
{
   return IsFade() ? -1 : 1;
}

string LookName()
{
   if(InpLook == LOOK_MONTH)
      return "1 month";
   if(InpLook == LOOK_6MONTH)
      return "6 months";
   if(InpLook == LOOK_YEAR)
      return "1 year";
   return "All";
}

string RunName()
{
   if(IsFade())
      return "Fade 50/50";
   if(InpRun == RUN_CONT_100_50)
      return "Continuation 100/50";
   return "Continuation 100/150";
}

string Pad2(int v)
{
   return (v < 10 ? "0" : "") + IntegerToString(v);
}

string YmdText(int ymd)
{
   return IntegerToString(ymd / 10000) + "-" + Pad2((ymd / 100) % 100) + "-" + Pad2(ymd % 100);
}

string PxText(double p)
{
   return DoubleToString(p, 2);
}

string OrderText(double level, int side, double slPx, double tpPx)
{
   double stop = level - side * slPx;
   double tgt = level + side * tpPx;
   return (side == 1 ? "Buy" : "Sell") + " stop " + PxText(stop) + "  tgt " + PxText(tgt);
}

string SourceText(const Level &lv)
{
   string text = lv.src1;
   if(lv.src2 != "")
      text += " · " + lv.src2;
   if(lv.nsrc > 2)
      text += " +" + IntegerToString(lv.nsrc - 2);
   return text;
}

void CheckDates()
{
   if(DaysFromCivil(1970, 1, 1) != 0)
      Print("Nasdaq levels: date math failed");
   if(DayOfWeekSun0(1970, 1, 1) != 4)
      Print("Nasdaq levels: weekday failed");
   if(NthSunday(2024, 3, 2) != 10 || NthSunday(2024, 11, 1) != 3)
      Print("Nasdaq levels: US daylight-saving Sunday failed");
   if(LastSunday(2024, 3) != 31 || LastSunday(2024, 10) != 27)
      Print("Nasdaq levels: London daylight-saving Sunday failed");
}

void ClearCandle(Candle &st)
{
   st.building = false;
   st.key = 0;
   st.op = 0;
   st.cl = 0;
   st.started = false;
   st.lastIn = 0;
   st.savedYmd = 0;
}

void ResetBook()
{
   g_n = 0;
   ArrayResize(g_raw, 0, 4096);
   ArrayInitialize(g_hash, -1);
   ClearCandle(g_day);
   ClearCandle(g_week);
   g_linesDirty = true;
}

int FindCents(int cents)
{
   int h = cents % HASH;
   if(h < 0)
      h += HASH;
   for(int i = g_hash[h]; i >= 0; i = g_raw[i].next)
   {
      if((int)MathRound(g_raw[i].price * 100.0) == cents)
         return i;
   }
   return -1;
}

void PushLevel(double px, int bit, datetime closeTs, datetime readyTs, int labelYmd, string kindName)
{
   double rounded = MathRound(px * 100.0) / 100.0;
   int cents = (int)MathRound(rounded * 100.0);
   int days = LookDays();
   datetime exp = (days == 0 ? (datetime)0 : closeTs + (datetime)((long)days * 86400));
   string piece = kindName + " " + YmdText(labelYmd);
   int idx = FindCents(cents);
   if(idx < 0)
   {
      idx = g_n;
      g_n++;
      ArrayResize(g_raw, g_n, 4096);
      int h = cents % HASH;
      if(h < 0)
         h += HASH;
      g_raw[idx].next = g_hash[h];
      g_hash[h] = idx;
      g_raw[idx].price = rounded;
      g_raw[idx].bits = bit;
      g_raw[idx].ready = readyTs;
      g_raw[idx].expire = exp;
      g_raw[idx].src1 = piece;
      g_raw[idx].src2 = "";
      g_raw[idx].nsrc = 1;
      return;
   }
   bool live = (g_raw[idx].expire == 0 || readyTs < g_raw[idx].expire);
   if(!live)
   {
      g_raw[idx].price = rounded;
      g_raw[idx].bits = bit;
      g_raw[idx].ready = readyTs;
      g_raw[idx].expire = exp;
      g_raw[idx].src1 = piece;
      g_raw[idx].src2 = "";
      g_raw[idx].nsrc = 1;
      return;
   }
   datetime merged = g_raw[idx].expire;
   if(days == 0 || g_raw[idx].expire == 0 || exp == 0)
      merged = 0;
   else if(exp > merged)
      merged = exp;
   g_raw[idx].bits = g_raw[idx].bits | bit;
   if(readyTs < g_raw[idx].ready)
      g_raw[idx].ready = readyTs;
   g_raw[idx].expire = merged;
   g_raw[idx].src2 = g_raw[idx].src1;
   g_raw[idx].src1 = piece;
   g_raw[idx].nsrc++;
}

bool StepCandle(Candle &st, bool inC, int key, int barYmd, int mins, datetime barTime, double barOpen, double barClose,
                double &eOpen, double &eClose, datetime &eTs, int &eLab)
{
   if(inC)
   {
      if(!st.building || key != st.key)
      {
         bool emit = st.building && st.started;
         if(emit)
         {
            eOpen = st.op;
            eClose = st.cl;
            eTs = st.lastIn;
            eLab = st.savedYmd;
         }
         st.building = true;
         st.key = key;
         st.op = barOpen;
         st.cl = barClose;
         st.started = (barYmd == key && mins >= 17 * 60);
         st.lastIn = barTime;
         st.savedYmd = barYmd;
         return emit;
      }
      st.cl = barClose;
      st.lastIn = barTime;
      st.savedYmd = barYmd;
      return false;
   }
   if(!st.building)
      return false;
   bool emit = st.started;
   if(emit)
   {
      eOpen = st.op;
      eClose = st.cl;
      eTs = st.lastIn;
      eLab = st.savedYmd;
   }
   st.building = false;
   return emit;
}

int WeekYmd(int openYmd)
{
   int y = openYmd / 10000;
   int m = (openYmd / 100) % 100;
   int d = openYmd % 100;
   int monday0 = (DayOfWeekSun0(y, m, d) + 6) % 7;
   int back = (monday0 + 1) % 7;
   AddDays(y, m, d, -back);
   return y * 10000 + m * 100 + d;
}

void ProcessBar(datetime barTime, double barOpen, double barClose)
{
   datetime utc = BarToUtc(barTime);
   int y, m, d, mins, ymd;
   ZoneCivil(utc, ChicagoOffset(utc), y, m, d, mins, ymd);
   bool inC = (mins >= 17 * 60 || mins < 16 * 60);
   int openYmd = ymd;
   if(mins < 16 * 60)
   {
      AddDays(y, m, d, -1);
      openYmd = y * 10000 + m * 100 + d;
   }
   int weekYmd = WeekYmd(openYmd);
   double eOpen, eClose;
   datetime eTs;
   int eLab;
   if(StepCandle(g_day, inC, openYmd, ymd, mins, barTime, barOpen, barClose, eOpen, eClose, eTs, eLab) && InpDaily)
   {
      PushLevel(eOpen, 1, eTs, barTime, eLab, "D open");
      PushLevel(eClose, 2, eTs, barTime, eLab, "D close");
   }
   if(StepCandle(g_week, inC, weekYmd, ymd, mins, barTime, barOpen, barClose, eOpen, eClose, eTs, eLab) && InpWeekly)
   {
      PushLevel(eOpen, 4, eTs, barTime, eLab, "W open");
      PushLevel(eClose, 8, eTs, barTime, eLab, "W close");
   }
}

bool IsActive(const Level &lv, datetime now)
{
   if(now < lv.ready)
      return false;
   if(lv.expire != 0 && now >= lv.expire)
      return false;
   bool daily = ((lv.bits & 3) != 0 && InpDaily);
   bool weekly = ((lv.bits & 12) != 0 && InpWeekly);
   return daily || weekly;
}

void DeleteKind(string kind)
{
   string prefix = Prefix() + kind;
   for(int i = ObjectsTotal(0, 0, -1) - 1; i >= 0; i--)
   {
      string name = ObjectName(0, i, 0, -1);
      if(StringFind(name, prefix) == 0)
         ObjectDelete(0, name);
   }
}

void DrawLines(double bid)
{
   DeleteKind("L");
   DeleteKind("A");
   int cap = InpMaxLines;
   if(cap < 1)
      cap = 1;
   if(cap > 500)
      cap = 500;
   datetime now = TimeCurrent();
   int picked[];
   double pickedDist[];
   ArrayResize(picked, 0, cap);
   ArrayResize(pickedDist, 0, cap);
   for(int i = 0; i < g_n; i++)
   {
      if(!IsActive(g_raw[i], now))
         continue;
      double dist = MathAbs(g_raw[i].price - bid);
      int n = ArraySize(picked);
      int pos = n;
      for(int k = 0; k < n; k++)
      {
         if(dist < pickedDist[k])
         {
            pos = k;
            break;
         }
      }
      if(pos < cap)
      {
         ArrayResize(picked, n + 1);
         ArrayResize(pickedDist, n + 1);
         for(int k = n; k > pos; k--)
         {
            picked[k] = picked[k - 1];
            pickedDist[k] = pickedDist[k - 1];
         }
         picked[pos] = i;
         pickedDist[pos] = dist;
         if(ArraySize(picked) > cap)
         {
            ArrayResize(picked, cap);
            ArrayResize(pickedDist, cap);
         }
      }
   }
   for(int i = 0; i < ArraySize(picked); i++)
   {
      Level lv = g_raw[picked[i]];
      bool weekly = ((lv.bits & 12) != 0);
      color col = weekly ? clrYellow : (color)0xFF6229;
      string name = Prefix() + "L" + IntegerToString(i);
      if(!ObjectCreate(0, name, OBJ_TREND, 0, lv.ready, lv.price, now, lv.price))
         continue;
      ObjectSetInteger(0, name, OBJPROP_RAY_RIGHT, true);
      ObjectSetInteger(0, name, OBJPROP_COLOR, col);
      ObjectSetInteger(0, name, OBJPROP_STYLE, ((lv.bits & 5) == 0 ? STYLE_DASH : STYLE_SOLID));
      ObjectSetInteger(0, name, OBJPROP_WIDTH, 1);
      ObjectSetInteger(0, name, OBJPROP_SELECTABLE, false);
      ObjectSetInteger(0, name, OBJPROP_HIDDEN, true);
      ObjectSetInteger(0, name, OBJPROP_BACK, false);
   }
   g_linesDirty = false;
}

bool InSession(datetime utc)
{
   int y, m, d, mins, ymd;
   ZoneCivil(utc, NyOffset(utc), y, m, d, mins, ymd);
   bool inNy = (mins >= 8 * 60 && mins < 17 * 60);
   bool inRth = (mins >= 9 * 60 + 30 && mins < 16 * 60);
   if(!IsFade())
      return inRth;
   int ly, lm, ld, lmins, lymd;
   ZoneCivil(utc, LondonOffset(utc), ly, lm, ld, lmins, lymd);
   bool inLon = (lmins >= 8 * 60 && lmins < 16 * 60 + 30);
   return inLon || inNy;
}

void AddLine(string &texts[], color &cols[], string text, color col)
{
   int n = ArraySize(texts);
   ArrayResize(texts, n + 1);
   ArrayResize(cols, n + 1);
   texts[n] = text;
   cols[n] = col;
}

void CollectSide(int &out[], double bid, int pass, int side)
{
   ArrayResize(out, 0, side);
   for(int n = 0; n < side; n++)
   {
      int best = -1;
      double bestDist = 0;
      for(int i = 0; i < g_n; i++)
      {
         if(!IsActive(g_raw[i], TimeCurrent()))
            continue;
         bool used = false;
         for(int k = 0; k < ArraySize(out); k++)
            if(out[k] == i)
               used = true;
         if(used)
            continue;
         double px = g_raw[i].price;
         bool match = (pass == 0 && MathAbs(px - bid) <= 0.001) || (pass == 1 && px > bid + 0.001) || (pass == 2 && px < bid - 0.001);
         if(!match)
            continue;
         double dist = MathAbs(px - bid);
         if(best < 0 || dist < bestDist)
         {
            best = i;
            bestDist = dist;
         }
      }
      if(best < 0)
         break;
      int nout = ArraySize(out);
      ArrayResize(out, nout + 1);
      out[nout] = best;
   }
}

void UpdateDashboard(double bid)
{
   DeleteKind("A");
   DeleteKind("D");
   int side = InpSide;
   if(side < 1)
      side = 1;
   if(side > 6)
      side = 6;
   double slPx = SlPts() * InpPoint;
   double tpPx = TpPts() * InpPoint;
   int upSide = UpSide();
   int dnSide = -upSide;
   color cText = C'232,232,232';
   color cMuted = C'168,168,168';
   color cBuy = C'80,220,120';
   color cSell = C'255,120,120';
   color upCol = (upSide == 1 ? cBuy : cSell);
   color dnCol = (dnSide == 1 ? cBuy : cSell);
   int active = 0;
   for(int i = 0; i < g_n; i++)
      if(IsActive(g_raw[i], TimeCurrent()))
         active++;
   string texts[];
   color cols[];
   ArrayResize(texts, 0, 32);
   ArrayResize(cols, 0, 32);
   string lot = IsFade() ? "0.10 lot" : "0.05 lot";
   string sess = IsFade() ? "London or New York" : "New York RTH";
   string rule = IsFade()
      ? "Cross up sells. Cross down buys. One at a time."
      : "Cross up buys. Cross down sells. Every level.";
   bool inSess = InSession(TimeGMT());
   AddLine(texts, cols, RunName() + "  ·  " + lot, cText);
   AddLine(texts, cols, LookName() + "  ·  " + IntegerToString(active) + " levels  ·  " + sess + "  ·  " + (inSess ? "in session" : "outside session"), cText);
   AddLine(texts, cols, rule + " One trade per New York day.", cText);
   AddLine(texts, cols, "Stop " + PxText(SlPts()) + "   target " + PxText(TpPts()) + "   fill at the level", cMuted);
   for(int pass = 0; pass < 3; pass++)
   {
      if(pass == 0)
      {
         int probe[];
         CollectSide(probe, bid, 0, 1);
         if(ArraySize(probe) == 0)
            continue;
      }
      AddLine(texts, cols, (pass == 0 ? "At price" : pass == 1 ? "Above" : "Below"), cMuted);
      int ids[];
      CollectSide(ids, bid, pass, side);
      if(ArraySize(ids) == 0)
      {
         AddLine(texts, cols, "none", cMuted);
         continue;
      }
      for(int k = 0; k < ArraySize(ids); k++)
      {
         Level lv = g_raw[ids[k]];
         AddLine(texts, cols, PxText(lv.price) + "   " + SourceText(lv), cText);
         AddLine(texts, cols, "up  " + OrderText(lv.price, upSide, slPx, tpPx), upCol);
         AddLine(texts, cols, "dn  " + OrderText(lv.price, dnSide, slPx, tpPx), dnCol);
      }
   }
   AddLine(texts, cols, "Blue daily, yellow weekly. Solid open, dashed close.", cMuted);
   AddLine(texts, cols, InpBarTimeIsUtc ? "Bar clock: UTC" : "Bar clock: server, converted with the current UTC offset", cMuted);

   int rowH = 20;
   int rows = ArraySize(texts);
   string bg = Prefix() + "DBG";
   ObjectCreate(0, bg, OBJ_RECTANGLE_LABEL, 0, 0, 0);
   ObjectSetInteger(0, bg, OBJPROP_CORNER, CORNER_RIGHT_UPPER);
   ObjectSetInteger(0, bg, OBJPROP_XDISTANCE, 8);
   ObjectSetInteger(0, bg, OBJPROP_YDISTANCE, 6);
   ObjectSetInteger(0, bg, OBJPROP_XSIZE, 720);
   ObjectSetInteger(0, bg, OBJPROP_YSIZE, 12 + rows * rowH);
   ObjectSetInteger(0, bg, OBJPROP_BGCOLOR, C'22,24,28');
   ObjectSetInteger(0, bg, OBJPROP_COLOR, C'90,90,90');
   ObjectSetInteger(0, bg, OBJPROP_BORDER_TYPE, BORDER_FLAT);
   ObjectSetInteger(0, bg, OBJPROP_FILL, true);
   ObjectSetInteger(0, bg, OBJPROP_BACK, false);
   ObjectSetInteger(0, bg, OBJPROP_SELECTABLE, false);
   ObjectSetInteger(0, bg, OBJPROP_HIDDEN, true);
   ObjectSetInteger(0, bg, OBJPROP_ZORDER, 10);
   for(int i = 0; i < rows; i++)
   {
      string name = Prefix() + "D" + IntegerToString(i);
      ObjectCreate(0, name, OBJ_LABEL, 0, 0, 0);
      ObjectSetInteger(0, name, OBJPROP_CORNER, CORNER_RIGHT_UPPER);
      ObjectSetInteger(0, name, OBJPROP_ANCHOR, ANCHOR_RIGHT_UPPER);
      ObjectSetInteger(0, name, OBJPROP_XDISTANCE, 18);
      ObjectSetInteger(0, name, OBJPROP_YDISTANCE, 12 + i * rowH);
      ObjectSetString(0, name, OBJPROP_TEXT, texts[i]);
      ObjectSetString(0, name, OBJPROP_FONT, "Consolas");
      ObjectSetInteger(0, name, OBJPROP_FONTSIZE, 9);
      ObjectSetInteger(0, name, OBJPROP_COLOR, cols[i]);
      ObjectSetInteger(0, name, OBJPROP_SELECTABLE, false);
      ObjectSetInteger(0, name, OBJPROP_HIDDEN, true);
      ObjectSetInteger(0, name, OBJPROP_ZORDER, 11);
   }
}

int OnInit()
{
   CheckDates();
   g_reset = true;
   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason)
{
   DeleteKind("L");
   DeleteKind("A");
   DeleteKind("D");
   Comment("");
}

int OnCalculate(const int rates_total,
                const int prev_calculated,
                const datetime &time[],
                const double &open[],
                const double &high[],
                const double &low[],
                const double &close[],
                const long &tick_volume[],
                const long &volume[],
                const int &spread[])
{
   if(rates_total < 2)
      return 0;
   if(prev_calculated == 0 || g_reset)
   {
      ResetBook();
      g_processed = 0;
      g_reset = false;
   }
   int closed = rates_total - 1;
   bool added = false;
   while(g_processed < closed)
   {
      ProcessBar(time[g_processed], open[g_processed], close[g_processed]);
      g_processed++;
      added = true;
   }
   double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
   if(bid <= 0)
      bid = close[rates_total - 1];
   if(added || g_linesDirty)
      DrawLines(bid);
   UpdateDashboard(bid);
   ChartRedraw(0);
   return rates_total;
}
