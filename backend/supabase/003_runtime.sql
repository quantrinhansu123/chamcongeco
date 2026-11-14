-- Run after schema.sql. Additive migration: existing employees, encodings and
-- attendance remain intact. Service-role access only. Never run destructive reset.
begin;

alter table public.employees add column if not exists face_model text not null default 'dlib-v1';
alter table public.employees add column if not exists face_templates jsonb not null default '[]';
alter table public.employees add column if not exists face_profiles jsonb not null default '{}';
alter table public.employees add column if not exists face_updated_at timestamptz;
alter table public.employees add column if not exists consented_at timestamptz;
alter table public.employees drop constraint if exists face_encoding_has_128_values;
alter table public.employees drop constraint if exists face_encoding_model_dimensions;
alter table public.employees add constraint face_encoding_model_dimensions check (
    (face_model = 'dlib-v1' and cardinality(face_encoding) = 128)
    or (face_model like 'buffalo_sc:%' and cardinality(face_encoding) = 512)
);
alter table public.attendance add column if not exists departed_at timestamptz;
alter table public.attendance add column if not exists checkin_photo text;
alter table public.attendance add column if not exists checkout_photo text;
create table if not exists public.punch_requests (
    request_id uuid primary key,
    employee_id text not null references public.employees(employee_id),
    attendance_date date not null,
    action text not null check (action in ('in','out')),
    status text not null check (status in ('pending','confirmed','abandoned')),
    occurred_at timestamptz not null,
    created_epoch double precision not null,
    model_id text not null,
    context jsonb not null,
    result jsonb
);
create unique index if not exists one_pending_punch
    on public.punch_requests(employee_id,attendance_date) where status='pending';
alter table public.punch_requests enable row level security;
revoke all on public.punch_requests from anon, authenticated;
grant all on public.punch_requests to service_role;

create or replace function public.attendance_error(code text, message text, status integer default 409)
returns jsonb language sql immutable set search_path=public as $$
    select jsonb_build_object('error',jsonb_build_object('code',code,'message',message,'status',status));
$$;

create or replace function public.attendance_receipt(p_request public.punch_requests, p_employee public.employees,
    p_attendance public.attendance, p_changed boolean)
returns jsonb language sql stable set search_path=public as $$
    select jsonb_build_object(
        'faces',p_request.context->'faces',
        'attendance_updated',case when p_changed then jsonb_build_array(p_employee.employee_id) else '[]'::jsonb end,
        'attendance',jsonb_build_array(jsonb_build_object(
            'employee_id',p_employee.employee_id,'name',p_employee.name,'is_arrive',p_attendance.arrived_at is not null,
            'arrived_at',p_attendance.arrived_at,'departed_at',p_attendance.departed_at,
            'requires_reenrollment',not (p_employee.face_model=p_request.model_id or p_employee.face_profiles ? p_request.model_id))),
        'request_id',p_request.request_id,'status','confirmed','action',p_request.action,'replayed',not p_changed);
$$;

create or replace function public.update_employee_face(p_employee_id text,p_changes jsonb)
returns jsonb language plpgsql set search_path=public as $$
declare e public.employees; profiles jsonb;
begin
    select * into e from employees where employee_id=p_employee_id for update;
    if not found then return attendance_error('employee_not_found','Không tìm thấy nhân viên.',404); end if;
    profiles := e.face_profiles || jsonb_build_object(e.face_model,
        case when jsonb_array_length(e.face_templates)>0 then e.face_templates else jsonb_build_array(to_jsonb(e.face_encoding)) end)
        || jsonb_build_object(p_changes->>'face_model',p_changes->'face_templates');
    update employees set face_encoding=array(select jsonb_array_elements_text(p_changes->'face_encoding')::double precision),
        face_model=p_changes->>'face_model',face_templates=p_changes->'face_templates',face_profiles=profiles,
        image_filename=p_changes->>'image_filename',face_updated_at=(p_changes->>'face_updated_at')::timestamptz,
        consented_at=(p_changes->>'consented_at')::timestamptz
        where employee_id=p_employee_id returning * into e;
    return to_jsonb(e);
end;
$$;

create or replace function public.reserve_attendance_request(p_request_id uuid,p_employee_id text,p_action text,
    p_now timestamptz,p_day date,p_model_id text,p_context jsonb,p_cooldown integer default 30,p_pending_timeout integer default 120)
returns jsonb language plpgsql set search_path=public as $$
declare r public.punch_requests; e public.employees; a public.attendance;
        selected text; duplicate boolean; epoch double precision;
begin
    if p_action not in ('auto','in','out') then return attendance_error('invalid_action','Loại chấm công không hợp lệ.',422); end if;
    -- Serialize the same request ID AND each employee/day across all application workers.
    perform pg_advisory_xact_lock(hashtextextended(p_request_id::text,0));
    select * into r from punch_requests where request_id=p_request_id;
    if found then
        if r.employee_id<>p_employee_id then return attendance_error('request_conflict','Lượt chấm công đã thuộc nhân viên khác.'); end if;
        if r.status='pending' and r.created_epoch < extract(epoch from p_now)-p_pending_timeout then
            update punch_requests set status='abandoned' where request_id=p_request_id returning * into r;
            return to_jsonb(r);
        end if;
        if r.status='abandoned' then return attendance_error('request_expired','Lượt trước đã hết hạn. Hãy bắt đầu lượt mới.'); end if;
        return to_jsonb(r);
    end if;
    perform pg_advisory_xact_lock(hashtextextended(p_employee_id||':'||p_day::text,0));
    epoch := extract(epoch from p_now);
    update punch_requests set status='abandoned' where employee_id=p_employee_id and attendance_date=p_day
        and status='pending' and created_epoch < epoch-p_pending_timeout;
    if exists(select 1 from punch_requests where employee_id=p_employee_id and attendance_date=p_day and status='pending') then
        return attendance_error('punch_pending','Nhân viên đang có lượt chấm công chưa hoàn tất. Vui lòng thử lại.');
    end if;
    select * into e from employees where employee_id=p_employee_id;
    if not found then return attendance_error('employee_not_found','Không tìm thấy nhân viên.',404); end if;
    select * into a from attendance where attendance_date=p_day and employee_id=p_employee_id;
    selected := case when p_action='auto' then case when a.arrived_at is null then 'in' else 'out' end else p_action end;
    if selected='out' and a.arrived_at is null then return attendance_error('arrival_required','Chưa có giờ vào hôm nay.',422); end if;
    duplicate := a.arrived_at is not null and (selected='in' or a.departed_at is not null);
    if p_action='auto' and a.arrived_at is not null and a.departed_at is null and p_now-a.arrived_at < make_interval(secs=>p_cooldown) then
        selected := 'in'; duplicate := true;
    end if;
    insert into punch_requests values(p_request_id,p_employee_id,p_day,selected,
        case when duplicate then 'confirmed' else 'pending' end,p_now,epoch,p_model_id,p_context,null) returning * into r;
    if duplicate then
        update punch_requests set result=attendance_receipt(r,e,a,false) where request_id=p_request_id returning * into r;
    end if;
    return to_jsonb(r);
end;
$$;

create or replace function public.complete_attendance_request(p_request_id uuid,p_photo_path text)
returns jsonb language plpgsql set search_path=public as $$
declare r public.punch_requests; e public.employees; a public.attendance;
        changed boolean; count_changed integer; expected text;
begin
    perform pg_advisory_xact_lock(hashtextextended(p_request_id::text,0));
    select * into r from punch_requests where request_id=p_request_id;
    if not found or r.status='abandoned' then return attendance_error('request_expired','Lượt chấm công không còn hiệu lực.'); end if;
    if r.status='confirmed' then return r.result; end if;
    perform pg_advisory_xact_lock(hashtextextended(r.employee_id||':'||r.attendance_date::text,0));
    -- Re-read AFTER the employee/day lock: expiry from another intent may have
    -- abandoned this request while completion waited. Avoid opposite row-lock order.
    select * into r from punch_requests where request_id=p_request_id for update;
    if r.status='abandoned' then return attendance_error('request_expired','Lượt chấm công không còn hiệu lực.'); end if;
    expected := r.attendance_date::text||'/'||r.employee_id||'/'||r.action||'/'||r.request_id::text||'.jpg';
    if p_photo_path<>expected or not exists(select 1 from storage.objects where bucket_id='attendance-photos' and name=p_photo_path) then
        return attendance_error('photo_required','Ảnh minh chứng chưa được lưu.',503);
    end if;
    if r.action='in' then
        insert into attendance(attendance_date,employee_id,is_arrive,arrived_at,last_distance,checkin_photo)
            values(r.attendance_date,r.employee_id,true,r.occurred_at,(r.context->>'distance')::double precision,p_photo_path)
            on conflict(attendance_date,employee_id) do nothing;
    else
        update attendance set departed_at=r.occurred_at,last_distance=(r.context->>'distance')::double precision,checkout_photo=p_photo_path
            where attendance_date=r.attendance_date and employee_id=r.employee_id and departed_at is null and arrived_at<=r.occurred_at;
    end if;
    get diagnostics count_changed = row_count;
    changed := count_changed>0;
    select * into a from attendance where attendance_date=r.attendance_date and employee_id=r.employee_id;
    if not found then return attendance_error('arrival_required','Chưa có giờ vào hôm nay.',422); end if;
    select * into e from employees where employee_id=r.employee_id;
    update punch_requests set status='confirmed',result=attendance_receipt(r,e,a,changed) where request_id=p_request_id returning * into r;
    return r.result;
end;
$$;

create or replace function public.expire_attendance_request(p_request_id uuid,p_now timestamptz,p_timeout integer default 120)
returns jsonb language plpgsql set search_path=public as $$
declare r public.punch_requests;
begin
    perform pg_advisory_xact_lock(hashtextextended(p_request_id::text,0));
    select * into r from punch_requests where request_id=p_request_id;
    if not found then return attendance_error('request_not_found','Không có lượt chấm công.',404); end if;
    perform pg_advisory_xact_lock(hashtextextended(r.employee_id||':'||r.attendance_date::text,0));
    update punch_requests set status='abandoned' where request_id=p_request_id and status='pending'
        and created_epoch < extract(epoch from p_now)-p_timeout;
    select * into r from punch_requests where request_id=p_request_id;
    return to_jsonb(r);
end;
$$;

-- No public RPC access. SECURITY INVOKER plus these grants keeps callers under
-- table RLS/privileges; the application alone holds the server key.
revoke all on function public.attendance_error(text,text,integer) from public,anon,authenticated;
revoke all on function public.attendance_receipt(public.punch_requests,public.employees,public.attendance,boolean) from public,anon,authenticated;
revoke all on function public.update_employee_face(text,jsonb) from public,anon,authenticated;
revoke all on function public.reserve_attendance_request(uuid,text,text,timestamptz,date,text,jsonb,integer,integer) from public,anon,authenticated;
revoke all on function public.complete_attendance_request(uuid,text) from public,anon,authenticated;
revoke all on function public.expire_attendance_request(uuid,timestamptz,integer) from public,anon,authenticated;
grant execute on function public.attendance_error(text,text,integer) to service_role;
grant execute on function public.attendance_receipt(public.punch_requests,public.employees,public.attendance,boolean) to service_role;
grant execute on function public.update_employee_face(text,jsonb) to service_role;
grant execute on function public.reserve_attendance_request(uuid,text,text,timestamptz,date,text,jsonb,integer,integer) to service_role;
grant execute on function public.complete_attendance_request(uuid,text) to service_role;
grant execute on function public.expire_attendance_request(uuid,timestamptz,integer) to service_role;
commit;
