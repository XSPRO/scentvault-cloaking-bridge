const express = require('express');
const fetch = require('node-fetch');

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Store B config
const STORE_DOMAIN = 'd1uaxf-xh.myshopify.com';
const STOREFRONT_TOKEN = 'f40c693b0aaf0d17799b8738307332d6';
const STOREFRONT_API = `https://${STORE_DOMAIN}/api/2025-01/graphql.json`;
const DISCORD_WEBHOOK = 'https://discord.com/api/webhooks/1470072581720768716/igNliuk2yPQabm4DllVcsj7MO8lVDbNerbTuhsDw9eu7kM5c7Hpz1oQyDIAEtR0grAkN';

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
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
            title
            variants(first: 50) {
              edges {
                node {
                  id
                  sku
                  title
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
        return {
          variantId: variant.node.id,
          productTitle: product.node.title,
          variantTitle: variant.node.title,
        };
      }
    }
  }
  return null;
}

// Create a cart on Store B
async function createCart(lineItems) {
  const query = `
    mutation cartCreate($input: CartInput!) {
      cartCreate(input: $input) {
        cart {
          id
          checkoutUrl
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const variables = {
    input: {
      lines: lineItems.map(item => ({
        merchandiseId: item.variantId,
        quantity: item.quantity,
      })),
    },
  };

  return await storefrontQuery(query, variables);
}

// Discord notification
function notifyDiscord(items, matchedItems) {
  const productList = matchedItems
    .map(i => `${i.productTitle} (x${i.quantity})`)
    .join('\n');

  fetch(DISCORD_WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content: '🛒 **Checkout Started**\nItems: ' + matchedItems.length + '\n\n' + productList,
    }),
  }).catch(() => {});
}

// Main bridge endpoint
app.post('/checkout-bridge', async (req, res) => {
  try {
    let items;
    if (typeof req.body.items === 'string') {
      items = JSON.parse(req.body.items);
    } else {
      items = req.body.items;
    }

    if (!items || items.length === 0) {
      return res.status(400).send('No items provided');
    }

    // Look up each SKU on Store B
    const lineItems = [];
    const matchedItems = [];

    for (const item of items) {
      const match = await findVariantBySku(item.sku);
      if (match) {
        lineItems.push({ variantId: match.variantId, quantity: item.quantity });
        matchedItems.push({ productTitle: match.productTitle, quantity: item.quantity });
      }
    }

    if (lineItems.length === 0) {
      return res.status(400).send('No matching products found on checkout store');
    }

    // Create cart on Store B
    const cartData = await createCart(lineItems);

    if (cartData.data?.cartCreate?.cart?.checkoutUrl) {
      const checkoutUrl = cartData.data.cartCreate.cart.checkoutUrl;

      // Send Discord notification after redirect
      setImmediate(() => notifyDiscord(items, matchedItems));

      res.set({
        'Referrer-Policy': 'no-referrer',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
      });

      return res.redirect(302, checkoutUrl);
    }

    const errors = cartData.data?.cartCreate?.userErrors;
    if (errors && errors.length > 0) {
      return res.status(500).send('Failed to create checkout: ' + errors.map(e => e.message).join(', '));
    }

    return res.status(500).send('Failed to create checkout');
  } catch (err) {
    return res.status(500).send('Bridge error: ' + err.message);
  }
});

// Health check
app.get('/', (req, res) => {
  res.json({
    status: 'ScentVault Checkout Bridge is live',
    timestamp: new Date().toISOString(),
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Bridge running on port ${PORT}`);
});
