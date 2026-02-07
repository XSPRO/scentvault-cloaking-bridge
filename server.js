const express = require('express');
const fetch = require('node-fetch');

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Store B config
const STORE_DOMAIN = 'd1uaxf-xh.myshopify.com';
const STOREFRONT_TOKEN = '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';
const STOREFRONT_API = `https://${STORE_DOMAIN}/api/2024-01/graphql.json`;

// CORS - update this to your Store A domain
const ALLOWED_ORIGINS = ['*'];

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin || '*');
    res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// GraphQL helper
async function storefrontQuery(query, variables = {}) {
  const res = await fetch(STOREFRONT_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Storefront-Access-Token': STOREFRONT_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });
  return res.json();
}

// Look up a variant by SKU on Store B
async function findVariantBySku(sku) {
  const query = `
    {
      products(first: 50, query: "sku:${sku}") {
        edges {
          node {
            variants(first: 50) {
              edges {
                node {
                  id
                  sku
                }
              }
            }
          }
        }
      }
    }
  `;
  const data = await storefrontQuery(query);
  
  if (!data.data || !data.data.products) return null;

  for (const product of data.data.products.edges) {
    for (const variant of product.node.variants.edges) {
      if (variant.node.sku === sku) {
        return variant.node.id;
      }
    }
  }
  return null;
}

// Create a checkout on Store B
async function createCheckout(lineItems) {
  const query = `
    mutation checkoutCreate($input: CheckoutCreateInput!) {
      checkoutCreate(input: $input) {
        checkout {
          webUrl
        }
        checkoutUserErrors {
          message
          field
        }
      }
    }
  `;

  const variables = {
    input: {
      lineItems: lineItems,
    },
  };

  const data = await storefrontQuery(query, variables);
  return data;
}

// Main bridge endpoint
app.post('/checkout-bridge', async (req, res) => {
  try {
    let items;

    // Parse items from request
    if (typeof req.body.items === 'string') {
      items = JSON.parse(req.body.items);
    } else {
      items = req.body.items;
    }

    if (!items || items.length === 0) {
      return res.status(400).send('No items provided');
    }

    console.log('Bridge received items:', items);

    // Look up each SKU on Store B and build line items
    const lineItems = [];
    for (const item of items) {
      const variantId = await findVariantBySku(item.sku);
      if (variantId) {
        lineItems.push({
          variantId: variantId,
          quantity: item.quantity,
        });
        console.log(`Matched SKU ${item.sku} -> ${variantId}`);
      } else {
        console.warn(`SKU not found on Store B: ${item.sku}`);
      }
    }

    if (lineItems.length === 0) {
      return res.status(400).send('No matching products found on checkout store');
    }

    // Create checkout on Store B
    const checkoutData = await createCheckout(lineItems);

    if (checkoutData.data?.checkoutCreate?.checkout?.webUrl) {
      const checkoutUrl = checkoutData.data.checkoutCreate.checkout.webUrl;
      console.log('Redirecting to:', checkoutUrl);
      return res.redirect(302, checkoutUrl);
    }

    // Handle errors
    const errors = checkoutData.data?.checkoutCreate?.checkoutUserErrors;
    console.error('Checkout errors:', errors);
    return res.status(500).send('Failed to create checkout');

  } catch (err) {
    console.error('Bridge error:', err);
    return res.status(500).send('Bridge error');
  }
});

// Health check
app.get('/', (req, res) => {
  res.send('Checkout bridge is running');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Checkout bridge running on port ${PORT}`);
});
