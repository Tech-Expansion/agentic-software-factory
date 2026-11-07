---
id: B-0001
title: Export orders for accounting
status: new
---
Our accountant needs the shop's orders in a spreadsheet each month. Add an "Export orders" button to the admin
orders page.

- The file is CSV, UTF-8 with a byte order mark so Excel shows Vietnamese names correctly, comma separated.
- Only users with the admin role see the button and can download the file.
- Columns, in this order: order number, date, customer name, total in VND, status.
- Totals are whole VND, with no decimals and no thousands separator.

The shop has sold about 400,000 orders since it opened. Order times are stored in UTC on the server; the shop and the
accountant are in Vietnam.
