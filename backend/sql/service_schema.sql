-- Services + Service Booking tables
-- Uses SERIAL so Postgres creates the underlying sequences automatically.

CREATE TABLE public.services (
  serviceid SERIAL PRIMARY KEY,
  courtid integer NOT NULL,
  name text NOT NULL,
  category public.servicecategory NOT NULL,
  price numeric NOT NULL,
  stock integer NOT NULL DEFAULT 0,
  images text[],
  status public.servicestatus NOT NULL DEFAULT 'active'::servicestatus,
  CONSTRAINT services_courtid_fkey FOREIGN KEY (courtid) REFERENCES public.courts(courtid)
);

CREATE TABLE public.servicebooking (
  servicebookingid SERIAL PRIMARY KEY,
  courtbookingid integer NOT NULL,
  serviceid integer NOT NULL,
  quantity integer NOT NULL,
  unit_price numeric NOT NULL,
  paymentid integer,
  CONSTRAINT servicebooking_courtbookingid_fkey FOREIGN KEY (courtbookingid) REFERENCES public.courtbooking(courtbookingid),
  CONSTRAINT servicebooking_serviceid_fkey FOREIGN KEY (serviceid) REFERENCES public.services(serviceid),
  CONSTRAINT servicebooking_paymentid_fkey FOREIGN KEY (paymentid) REFERENCES public.payments(paymentid)
);
