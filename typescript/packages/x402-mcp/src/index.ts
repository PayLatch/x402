/**
 * X402 MCP Integration
 *
 * Based on:
 * - 
 */

import type {
  McpServer,
  RegisteredTool,
  ToolCallback
} from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Client as MCPClient } from "@modelcontextprotocol/sdk/client/index.js";
import type {
  CallToolResultSchema,
  CompatibilityCallToolResultSchema,
  CallToolRequest,
  CallToolResult,
  ToolAnnotations
} from "@modelcontextprotocol/sdk/types.js";
import type { ZodRawShape } from "zod";

import { processPriceToAtomicAmount } from "x402/shared";
import { exact } from "x402/schemes";
import { useFacilitator } from "x402/verify";
import type {
  FacilitatorConfig,
  Network,
  PaymentPayload,
  PaymentRequirements,
  Wallet,
  Signer,
  MultiNetworkSigner,
  SupportedEVMNetworks,
  SupportedSVMNetworks,
  ERC20TokenAmount
} from "x402/types";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { getAddress } from "viem";

/*
  ======= SERVER SIDE =======
*/

export type X402Config = {
  network: Network;
  recipient: `0x${string}` | string; // Support both EVM and Solana addresses
  facilitator: FacilitatorConfig;
  version?: number;
};

export interface X402AugmentedServer {
  paidTool<Args extends ZodRawShape>(
    name: string,
    description: string,
    priceUSD: number,
    paramsSchema: Args,
    annotations: ToolAnnotations,
    cb: ToolCallback<Args>
  ): RegisteredTool;
}

export function withX402<T extends McpServer>(
  server: McpServer,
  cfg: X402Config
): T & X402AugmentedServer {
  const { verify, settle, supported } = useFacilitator(cfg.facilitator);
  const x402Version = cfg.version ?? 1;

  async function paidTool<Args extends ZodRawShape>(
    name: string,
    description: string,
    priceUSD: number,
    paramsSchema: Args,
    annotations: ToolAnnotations,
    cb: ToolCallback<Args>
  ): Promise<RegisteredTool> {
    return server.tool(
      name,
      description,
      paramsSchema,
      { ...annotations, paymentHint: true, paymentPriceUSD: priceUSD },
      (async (args, extra) => {
        // Build PaymentRequirements for this call
        const atomic = processPriceToAtomicAmount(priceUSD, cfg.network);
        if ("error" in atomic) {
          const payload = { x402Version, error: "PRICE_COMPUTE_FAILED" };
          return {
            isError: true,
            _meta: { "x402/error": payload },
            content: [{ type: "text", text: JSON.stringify(payload) }]
          } as const;
        }
        const { maxAmountRequired, asset } = atomic;

        let requirements: PaymentRequirements;

        // Handle EVM networks
        if (SupportedEVMNetworks.includes(cfg.network)) {
          requirements = {
            scheme: "exact" as const,
            network: cfg.network,
            maxAmountRequired,
            payTo: getAddress(cfg.recipient as `0x${string}`),
            asset: getAddress(asset.address),
            maxTimeoutSeconds: 300,
            resource: `x402://${name}`,
            mimeType: "application/json" as const,
            description,
            extra: "eip712" in asset ? asset.eip712 : undefined
          };
        }
        // Handle SVM (Solana) networks
        else if (SupportedSVMNetworks.includes(cfg.network)) {
          // Get the supported payments from the facilitator
          const paymentKinds = await supported();

          // Find the payment kind that matches the network and scheme
          let feePayer: string | undefined;
          for (const kind of paymentKinds.kinds) {
            if (kind.network === cfg.network && kind.scheme === "exact") {
              feePayer = kind?.extra?.feePayer;
              break;
            }
          }

          // If no fee payer is found, throw an error
          if (!feePayer) {
            const payload = {
              x402Version,
              error: `The facilitator did not provide a fee payer for network: ${cfg.network}.`
            };
            return {
              isError: true,
              _meta: { "x402/error": payload },
              content: [{ type: "text", text: JSON.stringify(payload) }]
            } as const;
          }

          requirements = {
            scheme: "exact" as const,
            network: cfg.network,
            maxAmountRequired,
            payTo: cfg.recipient,
            asset: asset.address,
            maxTimeoutSeconds: 300,
            resource: `x402://${name}`,
            mimeType: "application/json" as const,
            description,
            extra: {
              feePayer
            }
          };
        } else {
          const payload = {
            x402Version,
            error: `Unsupported network: ${cfg.network}`
          };
          return {
            isError: true,
            _meta: { "x402/error": payload },
            content: [{ type: "text", text: JSON.stringify(payload) }]
          } as const;
        }

        // Get token either from MCP _meta or from header
        const headers = extra?.requestInfo?.headers ?? {};
        const token =
          (extra?._meta?.["x402/payment"] as string | undefined) ??
          headers["X-PAYMENT"];

        const paymentRequired = (
          reason = "PAYMENT_REQUIRED",
          extraFields: Record<string, unknown> = {}
        ) => {
          const payload = {
            x402Version,
            error: reason,
            accepts: [requirements],
            ...extraFields
          };
          return {
            isError: true,
            _meta: { "x402/error": payload },
            content: [{ type: "text", text: JSON.stringify(payload) }]
          } as const;
        };

        if (!token || typeof token !== "string") return paymentRequired();

        // Decode & verify
        let decoded: PaymentPayload;
        try {
          decoded = exact.evm.decodePayment(token);
          decoded.x402Version = x402Version;
        } catch {
          return paymentRequired("INVALID_PAYMENT");
        }

        const vr = await verify(decoded, requirements);
        if (!vr.isValid) {
          return paymentRequired(vr.invalidReason ?? "INVALID_PAYMENT", {
            payer: vr.payer
          });
        }

        // Execute tool
        let result: CallToolResult;
        let failed = false;
        try {
          result = await cb(args, extra);
          if (
            result &&
            typeof result === "object" &&
            "isError" in result &&
            result.isError
          ) {
            failed = true;
          }
        } catch (e) {
          failed = true;
          result = {
            isError: true,
            content: [
              { type: "text", text: `Tool execution failed: ${String(e)}` }
            ]
          };
        }

        // Settle only on success
        if (!failed) {
          try {
            const s = await settle(decoded, requirements);
            if (s.success) {
              result._meta ??= {};
              result._meta["x402/payment-response"] = {
                success: true,
                transaction: s.transaction,
                network: s.network,
                payer: s.payer
              };
            } else {
              return paymentRequired(s.errorReason ?? "SETTLEMENT_FAILED");
            }
          } catch {
            return paymentRequired("SETTLEMENT_FAILED");
          }
        }

        return result;
      }) as ToolCallback<Args>
    );
  }

  Object.defineProperty(server, "paidTool", {
    value: paidTool,
    writable: false,
    enumerable: false,
    configurable: true
  });

  // Tell TS the object now also has the paidTool method
  return server as T & X402AugmentedServer;
}

/*
  ======= CLIENT SIDE =======
*/

export interface X402AugmentedClient {
  callTool(
    x402ConfirmationCallback:
      | ((payment: PaymentRequirements[]) => Promise<boolean>)
      | null,
    params: CallToolRequest["params"],
    resultSchema?:
      | typeof CallToolResultSchema
      | typeof CompatibilityCallToolResultSchema,
    options?: RequestOptions
  ): Promise<CallToolResult>;
}

export type X402ClientConfig = {
  walletClient: Signer | MultiNetworkSigner;
  maxPaymentValue?: bigint;
  version?: number;
  confirmationCallback?: (payment: PaymentRequirements[]) => Promise<boolean>; // Confirmation callback for payment
  x402Config?: {
    svmConfig?: { rpcUrl?: string };
    evmConfig?: { rpcUrls?: Record<Network, string> };
  };
};

export function withX402Client<T extends MCPClient>(
  client: T,
  x402Config: X402ClientConfig
): X402AugmentedClient & T {
  const { walletClient, version, x402Config: config } = x402Config;

  const maxPaymentValue = x402Config.maxPaymentValue ?? BigInt(0.1 * 10 ** 6); // 0.10 USDC

  const _listTools = client.listTools.bind(client);

  // Wrap the original method to include payment information in the description
  const listTools: typeof _listTools = async (params, options) => {
    const toolsRes = await _listTools(params, options);
    toolsRes.tools = toolsRes.tools.map((tool) => {
      let description = tool.description;
      if (tool.annotations?.paymentHint) {
        const cost = tool.annotations?.paymentPriceUSD
          ? `$${tool.annotations?.paymentPriceUSD}`
          : "an unknown amount";
        description += ` (This is a paid tool, you will be charged ${cost} for its execution)`;
      }
      return {
        ...tool,
        description
      };
    });

    return toolsRes;
  };

  const _callTool = client.callTool.bind(client);

  const callToolWithPayment = async (
    x402ConfirmationCallback:
      | ((payment: PaymentRequirements[]) => Promise<boolean>)
      | null,
    params: CallToolRequest["params"],
    resultSchema?:
      | typeof CallToolResultSchema
      | typeof CompatibilityCallToolResultSchema,
    options?: RequestOptions
  ): ReturnType<typeof client.callTool> => {
    // Import dynamically to avoid issues
    const { createPaymentHeader, selectPaymentRequirements } = await import("x402/client");
    const { isMultiNetworkSigner, isSvmSignerWallet, evm, ChainIdToNetwork } = await import("x402/types");

    // call the tool
    const res = await _callTool(params, resultSchema, options);

    // If it errored and returned accepts, we need to confirm payment
    const maybeX402Error = res._meta?.["x402/error"] as
      | { accepts: PaymentRequirements[] }
      | undefined;

    if (
      res.isError &&
      maybeX402Error &&
      maybeX402Error.accepts &&
      Array.isArray(maybeX402Error.accepts) &&
      maybeX402Error.accepts.length > 0
    ) {
      const accepts = maybeX402Error.accepts;
      const confirmationCallback =
        x402ConfirmationCallback ?? x402Config.confirmationCallback;

      // Use the x402 confirmation callback if provided
      if (confirmationCallback && !(await confirmationCallback(accepts))) {
        return {
          isError: true,
          content: [{ type: "text", text: "User declined payment" }]
        };
      }

      // Determine supported networks based on signer capabilities
      let network: Network | Network[] | undefined;
      if (isMultiNetworkSigner(walletClient)) {
        network = undefined; // Multi-network signer can handle any network
      } else if (evm.isSignerWallet(walletClient as typeof evm.EvmSigner)) {
        network = ChainIdToNetwork[(walletClient as typeof evm.EvmSigner).chain?.id];
      } else if (isSvmSignerWallet(walletClient as Signer)) {
        network = ["solana", "solana-devnet"] as Network[];
      }

      // Select the appropriate payment requirements
      const selectedRequirements = selectPaymentRequirements(accepts, network, "exact");

      if (!selectedRequirements) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "No compatible payment requirements found for this wallet"
            }
          ]
        };
      }

      const maxAmountRequired = BigInt(selectedRequirements.maxAmountRequired);
      if (maxAmountRequired > maxPaymentValue) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Payment exceeds client cap: ${maxAmountRequired} > ${maxPaymentValue}`
            }
          ]
        };
      }

      // Use x402/client to get the X-PAYMENT token
      const token = await createPaymentHeader(
        walletClient,
        version ?? 1,
        selectedRequirements,
        config
      );

      // Call the tool with the payment token
      return _callTool(
        {
          ...params,
          _meta: {
            ...params._meta,
            "x402/payment": token
          }
        },
        resultSchema,
        options
      );
    }

    return res;
  };

  const _client = client as X402AugmentedClient & T;
  _client.listTools = listTools;
  Object.defineProperty(_client, "callTool", {
    value: callToolWithPayment,
    writable: false,
    enumerable: false,
    configurable: true
  });

  return _client;
}

// Re-export types
export type {
  Network,
  Signer,
  MultiNetworkSigner,
  PaymentRequirements,
  FacilitatorConfig
} from "x402/types";