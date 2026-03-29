// ─── Store Credit Mutations ──────────────────────────────────

// Issue store credit to a customer
export const STORE_CREDIT_ACCOUNT_CREDIT = `#graphql
  mutation storeCreditAccountCredit($id: ID!, $creditInput: StoreCreditAccountCreditInput!) {
    storeCreditAccountCredit(id: $id, creditInput: $creditInput) {
      storeCreditAccountTransaction {
        id
        amount { amount currencyCode }
        account {
          id
          balance { amount currencyCode }
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

// Debit store credit from a customer
export const STORE_CREDIT_ACCOUNT_DEBIT = `#graphql
  mutation storeCreditAccountDebit($id: ID!, $debitInput: StoreCreditAccountDebitInput!) {
    storeCreditAccountDebit(id: $id, debitInput: $debitInput) {
      storeCreditAccountTransaction {
        id
        amount { amount currencyCode }
        account {
          id
          balance { amount currencyCode }
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;
