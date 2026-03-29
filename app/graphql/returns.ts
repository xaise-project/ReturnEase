// ─── Queries ─────────────────────────────────────────────────

export const GET_ORDER_BY_NAME_AND_EMAIL = `#graphql
  query getOrder($query: String!) {
    orders(first: 1, query: $query) {
      edges {
        node {
          id
          name
          email
          createdAt
          displayFinancialStatus
          displayFulfillmentStatus
          totalPriceSet {
            shopMoney { amount currencyCode }
          }
          lineItems(first: 50) {
            edges {
              node {
                id
                title
                quantity
                variant {
                  id
                  title
                  price
                  image { url altText }
                }
                product { id title }
              }
            }
          }
        }
      }
    }
  }
`;

export const GET_RETURNABLE_FULFILLMENTS = `#graphql
  query getReturnableFulfillments($orderId: ID!) {
    returnableFulfillments(orderId: $orderId, first: 50) {
      edges {
        node {
          fulfillment { id }
          returnableFulfillmentLineItems(first: 50) {
            edges {
              node {
                fulfillmentLineItem { id }
                quantity
                lineItem {
                  id
                  title
                  variant {
                    id
                    title
                    price
                    image { url altText }
                  }
                  product {
                    id
                    title
                    variants(first: 100) {
                      edges {
                        node {
                          id
                          title
                          price
                          availableForSale
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

// ─── Mutations ───────────────────────────────────────────────

// Create a return (refund only — no exchange items)
export const RETURN_CREATE = `#graphql
  mutation returnCreate($returnInput: ReturnInput!) {
    returnCreate(returnInput: $returnInput) {
      return {
        id
        status
        order { id name }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

// Create a return with exchange items
export const RETURN_CREATE_WITH_EXCHANGE = `#graphql
  mutation returnCreate($returnInput: ReturnInput!) {
    returnCreate(returnInput: $returnInput) {
      return {
        id
        status
        order { id name }
        exchangeLineItems(first: 10) {
          edges {
            node {
              lineItem {
                id
                title
                variant { id title price }
              }
            }
          }
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

// Approve a return request
export const RETURN_APPROVE = `#graphql
  mutation returnApproveRequest($input: ReturnApproveRequestInput!) {
    returnApproveRequest(input: $input) {
      return {
        id
        status
      }
      userErrors {
        field
        message
      }
    }
  }
`;

// Decline a return request
export const RETURN_DECLINE = `#graphql
  mutation returnDeclineRequest($input: ReturnDeclineRequestInput!) {
    returnDeclineRequest(input: $input) {
      return {
        id
        status
      }
      userErrors {
        field
        message
      }
    }
  }
`;

// Process a return (confirms exchange, creates fulfillment orders, records financials)
export const RETURN_PROCESS = `#graphql
  mutation returnProcess($id: ID!) {
    returnProcess(id: $id) {
      return {
        id
        status
      }
      userErrors {
        field
        message
      }
    }
  }
`;

// Close a completed return
export const RETURN_CLOSE = `#graphql
  mutation returnClose($id: ID!) {
    returnClose(id: $id) {
      return {
        id
        status
      }
      userErrors {
        field
        message
      }
    }
  }
`;
