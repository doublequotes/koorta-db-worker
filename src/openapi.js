const errorResponse = {
  description: "The request failed.",
  content: {
    "application/json": {
      schema: { $ref: "#/components/schemas/Error" },
    },
  },
};

const jsonBody = (schema, description = "Request payload") => ({
  required: true,
  description,
  content: {
    "application/json": {
      schema: { $ref: `#/components/schemas/${schema}` },
    },
  },
});

const responses = (successDescription, successSchema, errors = ["400", "401", "500"]) => ({
  "200": {
    description: successDescription,
    content: {
      "application/json": {
        schema: { $ref: `#/components/schemas/${successSchema}` },
      },
    },
  },
  ...Object.fromEntries(errors.map((status) => [status, errorResponse])),
});

const secured = [{ cloudflareAccess: [] }];
const apiKeySecured = [{ workerApiKey: [] }];
const adminAndApiKey = [{ cloudflareAccess: [], workerApiKey: [] }];

const openApi = {
  openapi: "3.1.0",
  info: {
    title: "Koorta DB Worker API",
    version: "1.0.0",
    description:
      "Order, customer support, promotions, returns, carrier webhook, and administration APIs served by koorta-db-worker. Admin routes require a Cloudflare Access session. Requests with `x-koorta-db-api-key` or `x-api-key` require the corresponding worker secret. Amounts are in INR unless noted.",
  },
  servers: [{ url: "/", description: "This Koorta DB Worker instance" }],
  tags: [
    { name: "System", description: "Health and API documentation" },
    { name: "Promotions", description: "Promo-code validation" },
    { name: "Orders", description: "Order creation and protected order lookup" },
    { name: "Customer", description: "Customer order lookup and self-service actions" },
    { name: "Enquiries", description: "Contact and wholesale enquiries" },
    { name: "Carrier", description: "Carrier event webhook" },
    { name: "Admin", description: "Cloudflare Access-protected order operations" },
  ],
  paths: {
    "/": {
      get: {
        tags: ["System"],
        summary: "Health check",
        operationId: "getHealth",
        responses: responses("Worker is running.", "HealthResponse", ["500"]),
      },
    },
    "/docs": {
      get: {
        tags: ["System"],
        summary: "Swagger UI",
        operationId: "getSwaggerUi",
        responses: {
          "200": {
            description: "Interactive Swagger UI page.",
            content: { "text/html": { schema: { type: "string" } } },
          },
        },
      },
    },
    "/openapi.json": {
      get: {
        tags: ["System"],
        summary: "OpenAPI document",
        operationId: "getOpenApiDocument",
        responses: {
          "200": {
            description: "OpenAPI 3.1 document for this worker.",
            content: {
              "application/json": {
                schema: { type: "object", properties: { openapi: { const: "3.1.0" } } },
              },
            },
          },
        },
      },
    },
    "/promo/validate": {
      post: {
        tags: ["Promotions"],
        summary: "Validate a promo code",
        operationId: "validatePromo",
        security: apiKeySecured,
        requestBody: jsonBody("PromoValidationRequest"),
        responses: responses("Promo validation result.", "PromoValidationResponse"),
      },
    },
    "/contact": {
      post: {
        tags: ["Enquiries"],
        summary: "Submit a contact enquiry",
        operationId: "submitContactEnquiry",
        security: apiKeySecured,
        requestBody: jsonBody("ContactEnquiry"),
        responses: responses("Enquiry accepted.", "SuccessResponse", ["400", "401", "502"]),
      },
    },
    "/wholesale-enquiry": {
      post: {
        tags: ["Enquiries"],
        summary: "Submit a wholesale enquiry",
        operationId: "submitWholesaleEnquiry",
        security: apiKeySecured,
        requestBody: jsonBody("WholesaleEnquiry"),
        responses: responses("Enquiry accepted.", "SuccessResponse", [
          "400",
          "401",
          "500",
          "502",
        ]),
      },
    },
    "/orders": {
      get: {
        tags: ["Orders"],
        summary: "List orders by customer contact",
        description:
          "Requires Cloudflare Access. Provide email, phone, or both; matching orders are limited to the newest 50.",
        operationId: "listOrders",
        security: secured,
        parameters: [
          {
            name: "email",
            in: "query",
            description: "Exact customer email match.",
            schema: { type: "string", format: "email" },
          },
          {
            name: "phone",
            in: "query",
            description: "Exact customer phone match.",
            schema: { type: "string" },
          },
        ],
        responses: responses("Matching orders.", "OrderListResponse", [
          "400",
          "401",
          "404",
          "500",
        ]),
      },
      post: {
        tags: ["Orders"],
        summary: "Create an order",
        description:
          "Creates the order, reserves catalog stock, creates a pending payment transaction, and sends order notifications. Promo totals are recalculated and must match the submitted values.",
        operationId: "createOrder",
        security: apiKeySecured,
        requestBody: jsonBody("CreateOrderRequest"),
        responses: {
          "201": {
            description: "Order created.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/CreateOrderResponse" },
              },
            },
          },
          "400": errorResponse,
          "401": errorResponse,
          "409": errorResponse,
          "500": errorResponse,
        },
      },
    },
    "/orders/{orderNumber}": {
      get: {
        tags: ["Orders"],
        summary: "Get an order by number",
        description: "Requires Cloudflare Access.",
        operationId: "getOrder",
        security: secured,
        parameters: [{ $ref: "#/components/parameters/OrderNumber" }],
        responses: responses("Order details.", "OrderResponse", [
          "401",
          "404",
          "500",
        ]),
      },
    },
    "/customer/order-lookup": {
      post: {
        tags: ["Customer"],
        summary: "Look up an order",
        description:
          "Requires a valid Turnstile token. The order number and phone must match the order.",
        operationId: "lookupCustomerOrder",
        requestBody: jsonBody("CustomerOrderLookupRequest"),
        responses: responses("Order timeline and self-service eligibility.", "CustomerOrderLookupResponse", [
          "400",
          "403",
          "404",
          "500",
        ]),
      },
    },
    "/customer/orders/{orderNumber}/contact": {
      post: {
        tags: ["Customer"],
        summary: "Update customer email and delivery note",
        description:
          "Requires the checkout phone number and a valid Turnstile token for the order_update action.",
        operationId: "updateCustomerOrderContact",
        parameters: [{ $ref: "#/components/parameters/OrderNumber" }],
        requestBody: jsonBody("CustomerOrderContactRequest"),
        responses: responses("Order contact details updated.", "CustomerOrderContactResponse", [
          "400",
          "403",
          "404",
          "409",
          "500",
        ]),
      },
    },
    "/customer/orders/{orderNumber}/requests": {
      post: {
        tags: ["Customer"],
        summary: "Request order cancellation or return",
        description:
          "Requires a valid Turnstile token for the order_request action. Returns also require policyConfirmed=true and selected item quantities.",
        operationId: "createCustomerOrderRequest",
        parameters: [{ $ref: "#/components/parameters/OrderNumber" }],
        requestBody: jsonBody("CustomerOrderRequest"),
        responses: {
          "201": {
            description: "Request created.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/CustomerOrderRequestResponse" },
              },
            },
          },
          "400": errorResponse,
          "403": errorResponse,
          "404": errorResponse,
          "409": errorResponse,
          "500": errorResponse,
        },
      },
    },
    "/webhooks/carrier-events": {
      post: {
        tags: ["Carrier"],
        summary: "Receive a carrier tracking event",
        description:
          "Authenticated with the configured Shiprocket webhook secret in the `x-api-key` header. The payload is carrier-defined; common Shiprocket fields are shown.",
        operationId: "receiveCarrierEvent",
        security: [{ carrierWebhookKey: [] }],
        requestBody: jsonBody("CarrierEvent"),
        responses: responses("Event accepted; matched indicates whether a shipment was found.", "CarrierEventResponse", [
          "400",
          "401",
          "500",
          "503",
        ]),
      },
    },
    "/admin/orders": {
      get: {
        tags: ["Admin"],
        summary: "List orders by customer contact (admin)",
        description:
          "Alias of GET /orders; requires Cloudflare Access. Provide email, phone, or both.",
        operationId: "adminListOrders",
        security: secured,
        parameters: [
          {
            name: "email",
            in: "query",
            schema: { type: "string", format: "email" },
          },
          {
            name: "phone",
            in: "query",
            schema: { type: "string" },
          },
        ],
        responses: responses("Matching orders.", "OrderListResponse", [
          "400",
          "401",
          "500",
        ]),
      },
      post: {
        tags: ["Admin"],
        summary: "Create an order (admin route)",
        description:
          "Alias of POST /orders. Requires both Cloudflare Access and the worker API key.",
        operationId: "adminCreateOrder",
        security: adminAndApiKey,
        requestBody: jsonBody("CreateOrderRequest"),
        responses: {
          "201": {
            description: "Order created.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/CreateOrderResponse" },
              },
            },
          },
          "400": errorResponse,
          "401": errorResponse,
          "409": errorResponse,
          "500": errorResponse,
        },
      },
    },
    "/admin/orders/{orderNumber}": {
      get: {
        tags: ["Admin"],
        summary: "Get an order by number (admin)",
        description: "Alias of GET /orders/{orderNumber}; requires Cloudflare Access.",
        operationId: "adminGetOrder",
        security: secured,
        parameters: [{ $ref: "#/components/parameters/OrderNumber" }],
        responses: responses("Order details.", "OrderResponse", [
          "401",
          "404",
          "500",
        ]),
      },
    },
    "/admin/orders/{orderNumber}/shipping": {
      post: {
        tags: ["Admin"],
        summary: "Manage forward or reverse shipping",
        description:
          "Requires Cloudflare Access. Actions: `book`, `cancel`, `manual_cancel`, or `manual`. `book` can create Shiprocket bookings; `manual` records tracking details.",
        operationId: "manageOrderShipping",
        security: secured,
        parameters: [{ $ref: "#/components/parameters/OrderNumber" }],
        requestBody: jsonBody("AdminShippingRequest"),
        responses: responses("Shipment action completed.", "AdminShipmentResponse", [
          "400",
          "401",
          "404",
          "409",
          "500",
          "502",
          "503",
        ]),
      },
    },
    "/admin/orders/{orderNumber}/status": {
      post: {
        tags: ["Admin"],
        summary: "Advance order fulfillment status",
        description:
          "Requires Cloudflare Access. Allowed transitions are pending → confirmed → shipped → delivered, one step at a time.",
        operationId: "advanceOrderStatus",
        security: secured,
        parameters: [{ $ref: "#/components/parameters/OrderNumber" }],
        requestBody: jsonBody("AdminOrderStatusRequest"),
        responses: responses("Order status advanced.", "AdminOrderStatusResponse", [
          "400",
          "401",
          "404",
          "409",
          "500",
        ]),
      },
    },
    "/admin/orders/{orderNumber}/payment": {
      post: {
        tags: ["Admin"],
        summary: "Mark a pending payment as received",
        description: "Requires Cloudflare Access.",
        operationId: "confirmOrderPayment",
        security: secured,
        parameters: [{ $ref: "#/components/parameters/OrderNumber" }],
        requestBody: jsonBody("AdminPaymentRequest"),
        responses: responses("Payment marked as received.", "AdminPaymentResponse", [
          "400",
          "401",
          "404",
          "409",
          "500",
        ]),
      },
    },
    "/admin/orders/{orderNumber}/requests/{transactionId}": {
      post: {
        tags: ["Admin"],
        summary: "Process a return or cancellation request",
        description:
          "Requires Cloudflare Access. Supported actions include `approve`, `reject`, `receive`, and `refund`; valid actions depend on request type and current status.",
        operationId: "processOrderRequest",
        security: secured,
        parameters: [
          { $ref: "#/components/parameters/OrderNumber" },
          {
            name: "transactionId",
            in: "path",
            required: true,
            description: "Transaction ID of the customer request.",
            schema: { type: "string", minLength: 1 },
          },
        ],
        requestBody: jsonBody("AdminOrderRequestAction"),
        responses: responses("Request action completed.", "AdminOrderRequestResponse", [
          "400",
          "401",
          "404",
          "409",
          "500",
        ]),
      },
    },
    "/admin/reports/monthly": {
      get: {
        tags: ["Admin"],
        summary: "Get monthly cash movement report",
        description:
          "Requires Cloudflare Access. Report event times use Asia/Kolkata, while year and month are calendar values.",
        operationId: "getMonthlyReport",
        security: secured,
        parameters: [
          {
            name: "year",
            in: "query",
            required: true,
            description: "Must be 2000 or later and no later than the current year.",
            schema: { type: "integer", minimum: 2000 },
          },
          {
            name: "month",
            in: "query",
            required: true,
            schema: { type: "integer", minimum: 1, maximum: 12 },
          },
        ],
        responses: responses("Monthly cash movement report.", "MonthlyReportResponse", [
          "400",
          "401",
          "500",
        ]),
      },
    },
  },
  components: {
    securitySchemes: {
      workerApiKey: {
        type: "apiKey",
        in: "header",
        name: "x-koorta-db-api-key",
        description: "KOORTA_DB_WORKER_API_SECRET configured on the worker.",
      },
      carrierWebhookKey: {
        type: "apiKey",
        in: "header",
        name: "x-api-key",
        description: "SHIPROCKET_WEBHOOK_SECRET configured on the worker.",
      },
      cloudflareAccess: {
        type: "apiKey",
        in: "cookie",
        name: "CF_Authorization",
        description:
          "A Cloudflare Access session cookie. When using Swagger UI, sign in through Cloudflare Access for this worker host first.",
      },
    },
    parameters: {
      OrderNumber: {
        name: "orderNumber",
        in: "path",
        required: true,
        description: "Koorta order number.",
        schema: { type: "string", minLength: 1, maxLength: 80 },
      },
    },
    schemas: {
      Error: {
        type: "object",
        required: ["success", "error"],
        properties: {
          success: { const: false },
          error: { type: "string" },
        },
      },
      SuccessResponse: {
        type: "object",
        required: ["success"],
        properties: { success: { const: true } },
      },
      HealthResponse: {
        type: "object",
        required: ["success", "message"],
        properties: {
          success: { const: true },
          message: { type: "string", example: "Koorta DB API is running." },
        },
      },
      PromoValidationRequest: {
        type: "object",
        required: ["subtotal"],
        properties: {
          code: { type: "string", description: "Promo code. Empty means no promo." },
          subtotal: { type: "number", minimum: 0 },
        },
      },
      PromoRule: {
        type: "object",
        required: ["code", "type", "value", "label", "minSubtotal", "active"],
        properties: {
          code: { type: "string" },
          type: { type: "string", enum: ["pct", "flat", "shipping"] },
          value: { type: "number" },
          label: { type: "string" },
          minSubtotal: { type: "number" },
          active: { type: "boolean" },
        },
      },
      PromoValidationResponse: {
        type: "object",
        required: ["valid", "message"],
        properties: {
          valid: { type: "boolean" },
          message: { type: "string" },
          rule: { anyOf: [{ $ref: "#/components/schemas/PromoRule" }, { type: "null" }] },
          discount: { type: "number" },
          shipping: { type: "number" },
          total: { type: "number" },
        },
      },
      ContactEnquiry: {
        type: "object",
        required: ["name", "email", "message"],
        properties: {
          name: { type: "string", minLength: 1, maxLength: 100 },
          email: { type: "string", format: "email", maxLength: 255 },
          message: { type: "string", minLength: 1, maxLength: 5000 },
        },
      },
      WholesaleEnquiry: {
        type: "object",
        required: [
          "businessName",
          "contactName",
          "email",
          "phone",
          "category",
          "deliveryDate",
          "products",
        ],
        properties: {
          businessName: { type: "string", minLength: 1, maxLength: 150 },
          contactName: { type: "string", minLength: 1, maxLength: 100 },
          email: { type: "string", format: "email", maxLength: 255 },
          phone: { type: "string", minLength: 1, maxLength: 30 },
          category: { type: "string", minLength: 1, maxLength: 80 },
          deliveryDate: {
            type: "string",
            format: "date",
            description: "Expected delivery date; must be at least 7 days from today.",
          },
          notes: { type: "string", maxLength: 2000 },
          products: {
            type: "array",
            minItems: 1,
            maxItems: 100,
            items: {
              type: "object",
              required: ["id", "quantity"],
              properties: {
                id: { type: "string" },
                name: { type: "string" },
                category: { type: "string" },
                quantity: { type: "integer", minimum: 10, maximum: 9999 },
                unitPrice: { type: "number", minimum: 0 },
                sizes: { type: "array", items: { type: "string" } },
              },
            },
          },
          totalQuantity: { type: "integer", minimum: 0 },
          estimatedValue: { type: "number", minimum: 0 },
        },
      },
      CreateOrderRequest: {
        type: "object",
        required: [
          "orderNumber",
          "customer",
          "payment",
          "items",
          "subtotal",
          "discount",
          "shipping",
          "total",
        ],
        properties: {
          orderNumber: { type: "string", minLength: 1, maxLength: 80 },
          placedAt: { type: "string", format: "date-time" },
          customer: {
            type: "object",
            required: [
              "name",
              "phone",
              "address",
              "city",
              "state",
              "district",
              "postOffice",
              "pincode",
            ],
            properties: {
              name: { type: "string", minLength: 1 },
              email: {
                anyOf: [
                  { type: "string", format: "email", maxLength: 255 },
                  { const: "" },
                ],
              },
              phone: { type: "string", minLength: 1 },
              address: { type: "string", minLength: 1 },
              city: { type: "string", minLength: 1 },
              state: { type: "string", minLength: 1 },
              district: { type: "string", minLength: 1 },
              postOffice: { type: "string", minLength: 1 },
              pincode: { type: "string", minLength: 1 },
              notes: { type: "string" },
            },
          },
          payment: { type: "string", enum: ["upi", "discuss"] },
          upiId: { type: "string" },
          promoCode: { type: "string" },
          items: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              required: ["id", "name", "size", "qty", "price"],
              properties: {
                id: { type: "string", minLength: 1 },
                name: { type: "string", minLength: 1 },
                size: { type: "string", minLength: 1 },
                qty: { type: "integer", minimum: 1 },
                price: { type: "integer", minimum: 0 },
                image: { type: "string" },
              },
            },
          },
          subtotal: { type: "number", minimum: 0 },
          discount: { type: "number", minimum: 0 },
          shipping: { type: "number", minimum: 0 },
          total: { type: "number", minimum: 0 },
        },
      },
      CreateOrderResponse: {
        type: "object",
        required: ["success", "orderNumber", "status", "transactionId"],
        properties: {
          success: { const: true },
          orderNumber: { type: "string" },
          status: { type: "string", const: "pending" },
          transactionId: { type: "string" },
          emailNotifications: { type: "array", items: { type: "object" } },
        },
      },
      OrderSummary: {
        type: "object",
        properties: {
          orderNumber: { type: "string" },
          placedAt: { type: "string", format: "date-time" },
          customer: { type: "object", additionalProperties: true },
          payment: { type: "string" },
          upiId: { type: ["string", "null"] },
          promoCode: { type: ["string", "null"] },
          subtotal: { type: "number" },
          discount: { type: "number" },
          shipping: { type: "number" },
          total: { type: "number" },
          status: { type: "string" },
          deliveredAt: { type: ["string", "null"], format: "date-time" },
          shipments: { type: "array", items: { $ref: "#/components/schemas/Shipment" } },
          items: { type: "array", items: { $ref: "#/components/schemas/OrderItem" } },
          transactions: { type: "array", items: { $ref: "#/components/schemas/Transaction" } },
        },
      },
      OrderItem: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          size: { type: "string" },
          qty: { type: "integer" },
          price: { type: "number" },
          image: { type: ["string", "null"] },
          returnableQty: { type: "integer" },
        },
      },
      Shipment: {
        type: "object",
        properties: {
          id: { type: "integer" },
          direction: { type: "string", enum: ["forward", "reverse"] },
          returnTransactionId: { type: ["string", "null"] },
          awb: { type: "string" },
          courier: { type: "string" },
          status: { type: "string" },
          lastEvent: { type: "string" },
          manifestUrl: { type: "string" },
          error: { type: "string" },
          manual: { type: "boolean" },
          deliveredAt: { type: ["string", "null"], format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
        },
      },
      Transaction: {
        type: "object",
        properties: {
          transactionId: { type: "string" },
          provider: { type: "string" },
          method: { type: "string" },
          status: { type: "string" },
          amount: { type: "number" },
          externalReference: { type: ["string", "null"] },
          metadata: { type: "object", additionalProperties: true },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
        },
      },
      OrderResponse: {
        type: "object",
        required: ["success", "order"],
        properties: {
          success: { const: true },
          order: { $ref: "#/components/schemas/OrderSummary" },
        },
      },
      OrderListResponse: {
        type: "object",
        required: ["success", "orders"],
        properties: {
          success: { const: true },
          orders: { type: "array", items: { $ref: "#/components/schemas/OrderSummary" } },
        },
      },
      CustomerOrderLookupRequest: {
        type: "object",
        required: ["orderNumber", "phone", "turnstileToken"],
        properties: {
          orderNumber: { type: "string", maxLength: 80 },
          phone: { type: "string", maxLength: 30 },
          turnstileToken: { type: "string" },
        },
      },
      CustomerShipment: {
        type: "object",
        properties: {
          awb: { type: "string" },
          courier: { type: "string" },
          status: { type: "string" },
          lastEvent: { type: "string" },
          manual: { type: "boolean" },
        },
      },
      CustomerOrderLookupResponse: {
        type: "object",
        required: ["success", "order"],
        properties: {
          success: { const: true },
          order: {
            type: "object",
            required: [
              "orderNumber",
              "placedAt",
              "status",
              "total",
              "payment",
              "paymentReceived",
              "cancellationEligible",
              "returnEligible",
              "requests",
              "items",
            ],
            properties: {
              orderNumber: { type: "string" },
              placedAt: { type: "string" },
              status: { type: "string" },
              deliveredAt: { type: ["string", "null"] },
              shipment: { anyOf: [{ $ref: "#/components/schemas/CustomerShipment" }, { type: "null" }] },
              total: { type: "number" },
              payment: { type: "string" },
              paymentReceived: { type: "boolean" },
              email: { type: "string" },
              deliveryNote: { type: "string" },
              cancellationEligible: { type: "boolean" },
              returnEligible: { type: "boolean" },
              requests: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    transactionId: { type: "string" },
                    status: { type: "string" },
                    amount: { type: "number" },
                    type: { type: "string", enum: ["return", "cancellation"] },
                    requestedAt: { type: ["string", "null"] },
                    approvedAt: { type: ["string", "null"] },
                    receivedAt: { type: ["string", "null"] },
                    refundedAt: { type: ["string", "null"] },
                    shipment: { anyOf: [{ $ref: "#/components/schemas/CustomerShipment" }, { type: "null" }] },
                  },
                },
              },
              items: { type: "array", items: { $ref: "#/components/schemas/OrderItem" } },
            },
          },
        },
      },
      CustomerOrderContactRequest: {
        type: "object",
        required: ["phone", "turnstileToken", "email", "deliveryNote"],
        properties: {
          phone: { type: "string", maxLength: 30 },
          turnstileToken: { type: "string" },
          email: {
            anyOf: [
              { type: "string", format: "email", maxLength: 255 },
              { const: "" },
            ],
          },
          deliveryNote: { type: "string", maxLength: 2000 },
        },
      },
      CustomerOrderContactResponse: {
        type: "object",
        required: ["success", "email", "deliveryNote"],
        properties: {
          success: { const: true },
          email: { type: "string" },
          deliveryNote: { type: "string" },
        },
      },
      CustomerOrderRequest: {
        type: "object",
        required: ["phone", "turnstileToken", "type", "reason"],
        properties: {
          phone: { type: "string", maxLength: 30 },
          turnstileToken: { type: "string" },
          type: { type: "string", enum: ["return", "cancellation"] },
          reason: { type: "string", minLength: 3, maxLength: 500 },
          policyConfirmed: {
            type: "boolean",
            description: "Must be true when type is return.",
          },
          items: {
            type: "array",
            minItems: 1,
            maxItems: 20,
            items: {
              type: "object",
              required: ["itemId", "size", "qty"],
              properties: {
                itemId: { type: "string" },
                size: { type: "string" },
                qty: { type: "integer", minimum: 1 },
              },
            },
          },
        },
      },
      CustomerOrderRequestResponse: {
        type: "object",
        required: ["success", "transactionId", "status"],
        properties: {
          success: { const: true },
          transactionId: { type: "string" },
          status: { type: "string", enum: ["return_requested", "cancellation_requested"] },
          estimatedRefund: { type: "number" },
          emailNotifications: { type: "array", items: { type: "object" } },
        },
      },
      CarrierEvent: {
        type: "object",
        description:
          "Shiprocket callback object. At least one of awb, awb_code, shipment_id, or order_id is typically needed to match a shipment.",
        properties: {
          awb: { type: ["string", "integer"] },
          awb_code: { type: ["string", "integer"] },
          shipment_id: { type: ["string", "integer"] },
          order_id: { type: ["string", "integer"] },
          current_status: { type: "string" },
          shipment_status: { type: "string" },
          status: { type: "string" },
          current_timestamp: { type: "string" },
          updated_at: { type: "string" },
          destination: { type: "string" },
          location: { type: "string" },
          courier_name: { type: "string" },
        },
        additionalProperties: true,
      },
      CarrierEventResponse: {
        type: "object",
        required: ["success", "matched"],
        properties: {
          success: { const: true },
          matched: { type: "boolean" },
        },
      },
      AdminShippingRequest: {
        type: "object",
        required: ["action"],
        properties: {
          action: { type: "string", enum: ["book", "cancel", "manual_cancel", "manual"] },
          direction: { type: "string", enum: ["forward", "reverse"], default: "forward" },
          transactionId: { type: "string", description: "Required for reverse shipment actions." },
          awb: { type: "string", maxLength: 100, description: "Used by manual action." },
          courier: { type: "string", maxLength: 100, description: "Used by manual action." },
          status: { type: "string", maxLength: 200, description: "Manual shipment status/event." },
        },
      },
      AdminShipmentResponse: {
        type: "object",
        required: ["success"],
        properties: {
          success: { const: true },
          shipment: { $ref: "#/components/schemas/Shipment" },
        },
      },
      AdminOrderStatusRequest: {
        type: "object",
        required: ["status"],
        properties: {
          status: { type: "string", enum: ["confirmed", "shipped", "delivered"] },
        },
      },
      AdminOrderStatusResponse: {
        type: "object",
        required: ["success", "status"],
        properties: {
          success: { const: true },
          status: { type: "string" },
          deliveredAt: { type: ["string", "null"], format: "date-time" },
        },
      },
      AdminPaymentRequest: {
        type: "object",
        properties: {
          reference: { type: "string", maxLength: 200 },
        },
      },
      AdminPaymentResponse: {
        type: "object",
        required: ["success", "status"],
        properties: {
          success: { const: true },
          status: { const: "paid" },
        },
      },
      AdminOrderRequestAction: {
        type: "object",
        required: ["action"],
        properties: {
          action: { type: "string", enum: ["approve", "reject", "receive", "refund"] },
          note: { type: "string", maxLength: 500, description: "Optional rejection note." },
          reference: {
            type: "string",
            maxLength: 200,
            description: "Required for refund action; external payment reference.",
          },
        },
      },
      AdminOrderRequestResponse: {
        type: "object",
        required: ["success", "status"],
        properties: {
          success: { const: true },
          status: { type: "string" },
          emailNotifications: { type: "array", items: { type: "object" } },
        },
      },
      MonthlyReportResponse: {
        type: "object",
        required: ["success", "year", "month", "currency", "basis", "summary", "transactions"],
        properties: {
          success: { const: true },
          year: { type: "integer" },
          month: { type: "integer", minimum: 1, maximum: 12 },
          currency: { const: "INR" },
          basis: { type: "string" },
          summary: {
            type: "object",
            properties: {
              cashCollected: { type: "number" },
              refundsPaid: { type: "number" },
              netCashCollected: { type: "number" },
              paymentCount: { type: "integer" },
              refundCount: { type: "integer" },
            },
          },
          transactions: {
            type: "array",
            items: {
              type: "object",
              properties: {
                transaction_id: { type: "string" },
                order_number: { type: "string" },
                method: { type: "string" },
                status: { type: "string" },
                amount: { type: "number" },
                external_reference: { type: ["string", "null"] },
                event_type: { type: "string", enum: ["payment", "refund"] },
                event_at: { type: "string", format: "date-time" },
              },
            },
          },
        },
      },
    },
  },
};

export default openApi;
