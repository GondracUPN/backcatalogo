import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Range } from './analytics.service';
import { SalesScope } from '../../utils/sales-scope';

const previousChange = (current: number, previous: number) =>
  previous > 0
    ? Math.round(((current - previous) / previous) * 1000) / 10
    : current === 0
      ? 0
      : null;
const metric = (current: number, previous: number) => ({
  current,
  previous,
  change: previousChange(current, previous),
});

@Injectable()
export class SalesAnalyticsService {
  constructor(private readonly db: DataSource) {}

  private async has(table: string) {
    return Boolean(
      (
        await this.db.query('SELECT to_regclass($1) AS name', [
          `public.${table}`,
        ])
      )[0]?.name,
    );
  }

  async summary(range: Range, scope: SalesScope) {
    const parameters = [
      range.prevFrom,
      range.from,
      range.to,
      scope.owner,
      scope.all,
    ];
    const rows = (await this.has('sold_records'))
      ? await this.db.query(
          `
      SELECT (sold_at >= $2) AS current,
        count(*)::int AS sales, COALESCE(sum(sale_price),0)::float8 AS revenue,
        COALESCE(sum(sale_price / NULLIF(exchange_rate,0)) FILTER(WHERE exchange_rate>0),0)::float8 AS usd,
        count(*) FILTER(WHERE exchange_rate>0)::int AS usd_sales
      FROM sold_records WHERE sold_at >= $1 AND sold_at < $3
        AND ($5::boolean OR owner_user_id IS NOT DISTINCT FROM $4::int) GROUP BY 1`,
          parameters,
        )
      : [];
    const current = rows.find((row: { current: boolean }) => row.current) || {
      sales: 0,
      revenue: 0,
      usd: 0,
      usd_sales: 0,
    };
    const previous = rows.find((row: { current: boolean }) => !row.current) || {
      sales: 0,
      revenue: 0,
      usd: 0,
      usd_sales: 0,
    };
    const requests = (await this.has('purchase_requests'))
      ? await this.db.query(
          `
      SELECT (created_at >= $2) AS current, count(*)::int AS total,
        count(*) FILTER(WHERE status='entregada')::int AS converted
      FROM purchase_requests WHERE created_at >= $1 AND created_at < $3
        AND ($5::boolean OR owner_user_id IS NOT DISTINCT FROM $4::int) GROUP BY 1`,
          parameters,
        )
      : [];
    const currentRequests = requests.find(
      (row: { current: boolean }) => row.current,
    ) || { total: 0, converted: 0 };
    const previousRequests = requests.find(
      (row: { current: boolean }) => !row.current,
    ) || { total: 0, converted: 0 };
    return {
      sales: metric(current.sales, previous.sales),
      revenue: metric(current.revenue, previous.revenue),
      revenueUsd: metric(current.usd, previous.usd),
      exchangeRateCoverage: { sales: current.usd_sales, total: current.sales },
      averageTicket: metric(
        current.sales ? current.revenue / current.sales : 0,
        previous.sales ? previous.revenue / previous.sales : 0,
      ),
      requests: metric(currentRequests.total, previousRequests.total),
      conversion: metric(
        currentRequests.total
          ? (currentRequests.converted / currentRequests.total) * 100
          : 0,
        previousRequests.total
          ? (previousRequests.converted / previousRequests.total) * 100
          : 0,
      ),
      conversionDefinition:
        'Solicitudes creadas en el periodo que actualmente están entregadas / solicitudes creadas. Las ventas manuales sin solicitud no forman parte de esta tasa.',
      margin: null,
      marginReason:
        'No disponible: no hay costo histórico por venta. El costo actual de inventario no permite reconstruir el margen histórico.',
    };
  }

  async timeline(range: Range, scope: SalesScope) {
    if (!(await this.has('sold_records'))) return { items: [] };
    return {
      items: await this.db.query(
        `
      WITH buckets AS (
        SELECT generate_series(date_trunc($3,$1::timestamptz AT TIME ZONE 'America/Lima'),
          date_trunc($3,($2::timestamptz-interval '1 microsecond') AT TIME ZONE 'America/Lima'),('1 '||$3)::interval) AS bucket
      ), totals AS (
        SELECT date_trunc($3,sold_at AT TIME ZONE 'America/Lima') AS bucket,
          count(*)::int AS sales,sum(sale_price)::float8 AS revenue FROM sold_records
        WHERE sold_at >= $1 AND sold_at < $2 AND ($5::boolean OR owner_user_id IS NOT DISTINCT FROM $4::int) GROUP BY 1
      ) SELECT to_char(b.bucket,'YYYY-MM-DD"T"HH24:MI') AS bucket,COALESCE(t.sales,0)::int AS sales,COALESCE(t.revenue,0)::float8 AS revenue
      FROM buckets b LEFT JOIN totals t USING(bucket) ORDER BY b.bucket`,
        [range.from, range.to, range.group, scope.owner, scope.all],
      ),
    };
  }

  async products(range: Range, scope: SalesScope) {
    if (!(await this.has('sold_records'))) return { items: [] };
    return {
      items: await this.db.query(
        `
      WITH scoped AS (
        SELECT * FROM sold_records WHERE sold_at >= $1 AND sold_at < $2
          AND ($4::boolean OR owner_user_id IS NOT DISTINCT FROM $3::int)
      ) SELECT COALESCE(NULLIF(p.title,''),NULLIF(s.product_title,''),'Sin modelo') AS model,
        COALESCE(st.category,'Sin categoría') AS category,count(*)::int AS units,
        sum(s.sale_price)::float8 AS revenue,
        avg(EXTRACT(EPOCH FROM(s.sold_at-pub.first_published_at))/86400)
          FILTER(WHERE pub.first_published_at<=s.sold_at)::float8 AS average_days_to_sale,
        count(*) FILTER(WHERE pub.first_published_at<=s.sold_at)::int AS dated_sales
      FROM scoped s
      LEFT JOIN products p ON p.sku=s.sku
      LEFT JOIN LATERAL (SELECT category FROM staged_products st WHERE st.sku=s.sku AND st.owner_user_id IS NOT DISTINCT FROM s.owner_user_id LIMIT 1) st ON true
      LEFT JOIN catalog_public pub ON pub.product_id=p.id
      GROUP BY 1,2 ORDER BY revenue DESC LIMIT 50`,
        [range.from, range.to, scope.owner, scope.all],
      ),
    };
  }

  async channels(range: Range, scope: SalesScope) {
    if (!(await this.has('sold_records'))) return { items: [] };
    return {
      items: await this.db.query(
        `
      SELECT COALESCE(sale_place_type,'sin_especificar') AS place_type,
        COALESCE(NULLIF(sale_location,''),'Sin especificar') AS location,
        COALESCE(customer_kind,'sin_especificar') AS customer_kind,
        count(*)::int AS sales,sum(sale_price)::float8 AS revenue FROM sold_records
      WHERE sold_at >= $1 AND sold_at < $2 AND ($4::boolean OR owner_user_id IS NOT DISTINCT FROM $3::int)
      GROUP BY 1,2,3 ORDER BY revenue DESC LIMIT 50`,
        [range.from, range.to, scope.owner, scope.all],
      ),
    };
  }

  async stock(scope: SalesScope) {
    const items = await this.db.query(
      `
      SELECT st.id,st.sku,st.title,st.category,st.stock,st.created_at,
        EXTRACT(EPOCH FROM(now()-st.created_at))/86400 AS age_days,
        pub.first_published_at
      FROM staged_products st
      LEFT JOIN products p ON p.sku=st.sku
      LEFT JOIN catalog_public pub ON pub.product_id=p.id
      WHERE st.status IN ('published','listed') AND st.stock>0
        AND ($2::boolean OR st.owner_user_id IS NOT DISTINCT FROM $1::int)
        AND COALESCE(pub.is_published,st.status='published')
      ORDER BY st.created_at,st.id`,
      [scope.owner, scope.all],
    );
    return {
      active: items.length,
      averageAgeDays: items.length
        ? items.reduce(
            (total: number, row: { age_days: string }) =>
              total + Number(row.age_days),
            0,
          ) / items.length
        : 0,
      over30: items.filter(
        (row: { age_days: string }) => Number(row.age_days) > 30,
      ).length,
      over60: items.filter(
        (row: { age_days: string }) => Number(row.age_days) > 60,
      ).length,
      items: items
        .filter((row: { age_days: string }) => Number(row.age_days) > 30)
        .slice(0, 50),
      ageDefinition:
        'Antigüedad desde el alta en inventario. La primera publicación se informa solo cuando quedó registrada.',
    };
  }

  async sellers(range: Range) {
    const saleTable = await this.has('sold_records');
    const aggregate = saleTable
      ? `SELECT owner_user_id,
      count(*) FILTER(WHERE sold_at >= $2)::int AS sales,
      COALESCE(sum(sale_price) FILTER(WHERE sold_at >= $2),0)::float8 AS revenue,
      COALESCE(sum(sale_price) FILTER(WHERE sold_at < $2),0)::float8 AS previous_revenue,
      max(sold_at) FILTER(WHERE sold_at >= $2) AS last_sale
      FROM sold_records WHERE sold_at >= $1 AND sold_at < $3 GROUP BY owner_user_id`
      : `SELECT NULL::int AS owner_user_id,0 AS sales,0 AS revenue,0 AS previous_revenue,NULL::timestamptz AS last_sale WHERE false`;
    const items = await this.db.query(
      `WITH sales AS (${aggregate}), stock AS (
      SELECT st.owner_user_id,count(*)::int AS active FROM staged_products st
        LEFT JOIN products p ON p.sku=st.sku LEFT JOIN catalog_public pub ON pub.product_id=p.id
        WHERE st.status IN ('published','listed') AND st.stock>0
          AND COALESCE(pub.is_published,st.status='published') GROUP BY st.owner_user_id
    ) SELECT u.id AS owner_id,u.username,COALESCE(s.sales,0)::int AS sales,
      COALESCE(s.revenue,0)::float8 AS revenue,COALESCE(s.previous_revenue,0)::float8 AS previous_revenue,
      COALESCE(st.active,0)::int AS active,${saleTable ? '(SELECT max(last.sold_at) FROM sold_records last WHERE last.owner_user_id=u.id)' : 'NULL::timestamptz'} AS last_sale
      FROM "User" u LEFT JOIN sales s ON s.owner_user_id=u.id LEFT JOIN stock st ON st.owner_user_id=u.id
      WHERE u.role='VENDEDOR' AND NOT u.can_view_service_inventory ORDER BY revenue DESC,u.id`,
      [range.prevFrom, range.from, range.to],
    );
    return {
      items: items.map(
        (row: {
          sales: number;
          revenue: number;
          previous_revenue: number;
        }) => ({
          ...row,
          average_ticket: row.sales ? row.revenue / row.sales : 0,
          change: previousChange(row.revenue, row.previous_revenue),
        }),
      ),
    };
  }
}
