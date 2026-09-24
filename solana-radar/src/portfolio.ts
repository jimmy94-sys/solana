import { useEffect, useState } from "react";

const RPC_ENDPOINT = import.meta.env.VITE_SOLANA_RPC_URL || "https://api.devnet.solana.com";
const TOKEN_PROGRAMS = [
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFPrwEAfocH29CmSGj",
] as const;
const LAMPORTS_PER_SOL = 1_000_000_000;

export type Holding = { mint: string; amount: number; decimals: number; accounts: number; program: string };
export type Activity = { signature: string; slot: number; timestamp: number | null; error: boolean };
export type Snapshot = { sol: number; holdings: Holding[]; activity: Activity[]; fetchedAt: number };

type TokenAccount = {
  account: { data: { parsed: { info: { mint: string; tokenAmount: { amount: string; decimals: number } } } } };
};
type Signature = { signature: string; slot: number; blockTime: number | null; err: unknown };

async function rpc<T>(method: string, params: unknown[], signal: AbortSignal): Promise<T> {
  const response = await fetch(RPC_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal,
  });
  if (!response.ok) throw new Error(`RPC ${response.status}: ${response.statusText}`);
  const payload: { result?: T; error?: { message: string } } = await response.json();
  if (payload.error) throw new Error(payload.error.message);
  if (payload.result === undefined) throw new Error(`No result from ${method}`);
  return payload.result;
}

export async function fetchSnapshot(address: string, signal: AbortSignal): Promise<Snapshot> {
  const [balance, legacy, token2022, signatures] = await Promise.all([
    rpc<{ value: number }>("getBalance", [address, { commitment: "confirmed" }], signal),
    rpc<{ value: TokenAccount[] }>("getTokenAccountsByOwner", [address, { programId: TOKEN_PROGRAMS[0] }, { encoding: "jsonParsed", commitment: "confirmed" }], signal),
    rpc<{ value: TokenAccount[] }>("getTokenAccountsByOwner", [address, { programId: TOKEN_PROGRAMS[1] }, { encoding: "jsonParsed", commitment: "confirmed" }], signal),
    rpc<Signature[]>("getSignaturesForAddress", [address, { limit: 12, commitment: "confirmed" }], signal),
  ]);
  const byMint = new Map<string, Holding>();
  for (const [program, accounts] of [[TOKEN_PROGRAMS[0], legacy.value], [TOKEN_PROGRAMS[1], token2022.value]] as const) {
    for (const { account } of accounts) {
      const info = account.data.parsed.info;
      const raw = BigInt(info.tokenAmount.amount);
      if (raw === 0n) continue;
      const { mint, tokenAmount } = info;
      const amount = Number(raw) / 10 ** tokenAmount.decimals;
      const existing = byMint.get(mint);
      if (existing) { existing.amount += amount; existing.accounts++; }
      else byMint.set(mint, { mint, amount, decimals: tokenAmount.decimals, accounts: 1, program });
    }
  }
  return {
    sol: balance.value / LAMPORTS_PER_SOL,
    holdings: [...byMint.values()].sort((a, b) => b.amount - a.amount),
    activity: signatures.map((s) => ({ signature: s.signature, slot: s.slot, timestamp: s.blockTime, error: s.err !== null })),
    fetchedAt: Date.now(),
  };
}

export function usePortfolio(address?: string) {
  const [result, setResult] = useState<{ address: string; snapshot: Snapshot } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (!address) return;
    const controller = new AbortController();
    // Retain prior data while refreshing the same wallet, but never show it for another wallet.
    setLoading(true);
    setError(null);
    fetchSnapshot(address, controller.signal)
      .then((next) => { if (!controller.signal.aborted) setResult({ address, snapshot: next }); })
      .catch((cause: unknown) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Unable to load wallet"); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [address, refresh]);
  return { snapshot: result?.address === address ? result?.snapshot ?? null : null, error, loading, reload: () => setRefresh((n) => n + 1) };
}
