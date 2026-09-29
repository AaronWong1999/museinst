// types.ts — Financial data model contracts.
// Contract invariant: every quote/profile MUST carry source, asOf, market, and currency.
// No synthetic/fabricated numbers: failures return explicit error status.

export type AssetClass = "equity" | "etf" | "index" | "commodity" | "fx" | "crypto";

export interface FinancialQuote {
  symbol: string;
  code: string;
  name: string;
  market: "us" | "hk" | "cn" | "commodity" | "fx" | "index" | "crypto";
  assetClass: AssetClass;
  currency: string;
  price: number;
  change: number;
  changePct: number;
  prevClose: number;
  open: number;
  high: number;
  low: number;
  volume: number;
  asOf: string; // ISO 8601 or exchange timestamp
  source: string;
  caveat?: string; // disambiguation warning if partial match
}

export interface KlineCandle {
  date: string;
  open: number;
  close: number;
  high: number;
  low: number;
  volume: number;
}

export interface KlineData {
  symbol: string;
  code: string;
  period: string;
  market: string;
  currency: string;
  asOf: string;
  source: string;
  candles: KlineCandle[];
}

export interface StockProfile {
  symbol: string;
  code: string;
  name: string;
  market: string;
  currency: string;
  asOf: string;
  source: string;
  peTtm?: number;
  peDynamic?: number;
  pb?: number;
  peg?: number;
  roe?: number;
  grossMarginPct?: number;
  netMarginPct?: number;
  revenueGrowthPct?: number;
  profitGrowthPct?: number;
  eps?: number;
  analystConsensus?: {
    targetPriceAvg?: number;
    rating?: string;
  };
  topHolders?: Array<{ name: string; holdRatioPct: number }>;
}

export interface FinanceNewsItem {
  title: string;
  digest?: string;
  source: string;
  time: string; // ISO 8601 with explicit timezone (+08:00 or UTC)
  url?: string;
}
