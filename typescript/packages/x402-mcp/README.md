# x402-mcp

Model Context Protocol (MCP) integration for the x402 Payment Protocol. This package allows you to add payment functionality to your MCP servers and clients using the x402 protocol, supporting both EVM (Ethereum) and SVM (Solana) networks.

## Installation

```bash
npm install @paylatch/x402-mcp
```

## Quick Start

### Server Side (TypeScript)

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withX402 } from "@paylatch/x402-mcp";
import { z } from "zod";

const server = new McpServer({
  name: "my-paid-mcp-server",
  version: "1.0.0"
});

// Add x402 payment support
const paidServer = withX402(server, {
  network: "base-sepolia",
  recipient: "0xYourAddress", // EVM address for base-sepolia
  facilitator: {
    url: "https://x402.org/facilitator"
  }
});

// Create a paid tool
paidServer.paidTool(
  "premium-data",
  "Get premium data",
  0.10, // Price in USD
  {
    query: z.string().describe("Your query")
  },
  {},
  async (args) => {
    return {
      content: [
        { type: "text", text: `Premium result for: ${args.query}` }
      ]
    };
  }
);
```

### Client Side (TypeScript)

```typescript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { withX402Client } from "@paylatch/x402-mcp";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

// Create wallet client
const account = privateKeyToAccount("0xYourPrivateKey");
const walletClient = createWalletClient({
  account,
  transport: http(),
  chain: baseSepolia
});

// Create MCP client with payment support
const client = new Client({
  name: "my-client",
  version: "1.0.0"
});

const paidClient = withX402Client(client, {
  walletClient,
  maxPaymentValue: BigInt(0.1 * 10 ** 6), // 0.10 USDC max
  confirmationCallback: async (requirements) => {
    console.log("Payment required:", requirements);
    return true; // Auto-approve
  }
});

// Call a paid tool
const result = await paidClient.callTool(
  null, // or provide custom confirmation callback
  {
    name: "premium-data",
    arguments: { query: "test" }
  }
);
```

## Multi-Network Support

x402-mcp supports all networks available in the x402 SDK, including:

### EVM Networks

  - base
  - base-sepolia
  - And other EVM-compatible chains

### Solana Networks

  - solana
  - solana-devnet

### Example with Solana (TypeScript)

```typescript
// Server configuration for Solana
const paidServer = withX402(server, {
  network: "solana-devnet",
  recipient: "YourSolanaAddress", // Solana address
  facilitator: {
    url: "https://x402.org/facilitator"
  }
});
```

The facilitator automatically provides network-specific metadata (like fee payers for Solana transactions).

## Configuration

### Server Configuration (X402Config)

```typescript
type X402Config = {
  network: Network;                    // Network to use
  recipient: Address | SolanaAddress;  // Payment recipient address
  facilitator: FacilitatorConfig;      // Facilitator service config
  version?: number;                    // x402 version (default: 1)
};
```

### Client Configuration (X402ClientConfig)

```typescript
type X402ClientConfig = {
  walletClient: Signer | MultiNetworkSigner;  // Wallet for signing payments
  maxPaymentValue?: bigint;                   // Max payment cap (default: 0.10 USDC)
  version?: number;                           // x402 version (default: 1)
  confirmationCallback?: (requirements: PaymentRequirements[]) => Promise<boolean>;
  x402Config?: {
    svmConfig?: { rpcUrl?: string };          // Custom Solana RPC
    evmConfig?: { rpcUrls?: Record<Network, string> };  // Custom EVM RPCs
  };
};
```

## Features

  - Multi-network support: Works with EVM and Solana networks
  - Automatic payment handling: Client automatically handles 402 responses
  - Payment confirmation: Optional callback to confirm payments before execution
  - Flexible signers: Support for single-network and multi-network wallet signers
  - Network detection: Automatically detects wallet capabilities and selects compatible payment methods
  - Facilitator integration: Fetches network-specific metadata (e.g., Solana fee payers)

## Resources

  - x402 Protocol
  - Model Context Protocol

