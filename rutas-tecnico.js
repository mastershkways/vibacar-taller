// rutas-tecnico.js — API del técnico (F4-05 tablero del técnico + F4-06 cronómetro): su día, el cronómetro por tramos y el
// checklist de la O.T. La lógica está en tiempos.js; el cambio de estado y el alcance, en rutas-ot.js.
//
//   GET  /api/mi-dia[?dia=AAAA-MM-DD][&tecnico_id=N]   lo accionable del técnico: en curso, bloques del día y atrasadas; su
//                                                       cronómetro abierto, los próximos días y el resumen de horas del día.
//                                                       La oficina (quien ve el Planificador) puede mirar el día de un técnico.
//   POST /api/ot/:id/crono { accion, nota?, cerrar_otra? }   accion = desplazamiento | espera | trabajo | parar
//   GET  /api/ot/:id/tiempos                            tramos y totales de la O.T.
//   PUT  /api/ot/:id/checklist/:pid { resultado, nota? }     resultado = hecho | no_aplica | incidencia | null
//
// Reglas:
//   - Solo fichan el técnico y el SAT (alcance `asignadas`), y solo en sus O.T. planificadas o en curso. El primer tramo pasa la
//     O.T. a "en curso". "parar" = parar por hoy: cierra el tramo y la O.T. sigue en curso (y en su tablero) para otro día.
//     Pausar (falta repuesto, cliente…) y finalizar son cambios de estado (POST /api/ot/:id/estado): cierran el tramo abierto.
//   - Un técnico solo tiene un cronómetro en marcha: si lo tiene en otra O.T., 409 con `abierto` salvo que mande `cerrar_otra`.
//   - La hora la pone el servidor; la respuesta lleva `inicio` y `segundos` para que la tablet solo pinte.

const express = require('express');
const crypto = require('crypto');
const { db, ahora } = require('./db');
const { requierePermiso, alcanceDe } = require('./permisos');
const { ErrorHttp, texto, entero, enumerado, idRuta } = require('./validar');
const rutasOT = require('./rutas-ot');
const tiempos = require('./tiempos');
const { JORNADA } = require('./rutas-planificador');

const DIAS_PROXIMOS = 7;
const TAREAS_MAX = 100;
const dos = (n) => String(n).padStart(2, '0');
const fechaISO = (d) => `${d.getFullYear()}-${dos(d.getMonth() + 1)}-${dos(d.getDate())}`;
function esFecha(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [a, m, d] = s.split('-').map(Number);
  const f = new Date(a, m - 1, d);
  return f.getFullYear() === a && f.getMonth() === m - 1 && f.getDate() === d;
}
const sumarDias = (iso, n) => { const [a, m, d] = iso.split('-').map(Number); return fechaISO(new Date(a, m - 1, d + n)); };

const stmt = {
  tecnico: db.prepare("SELECT id, nombre, rol, activo FROM usuarios WHERE id = ? AND rol IN ('tecnico', 'sat')"),
  historial: db.prepare('INSERT INTO ot_historial (ot_id, estado_anterior, estado_nuevo, usuario_id, fecha, nota) VALUES (?, ?, ?, ?, ?, ?)'),
  estadoOT: db.prepare('SELECT estado FROM ot WHERE id = ?'),
  progreso: db.prepare('SELECT COUNT(*) AS total, COALESCE(SUM(resultado IS NOT NULL), 0) AS respondidos FROM ot_checklist WHERE ot_id = ?'),
  tareas: db.prepare(`
    SELECT o.id, o.numero, o.estado, e.nombre AS estado_nombre, e.color AS estado_color, o.etiqueta, et.nombre AS etiqueta_nombre, et.color AS etiqueta_color,
           o.prioridad, o.tipo, o.sintoma, o.descripcion, o.version, o.tecnico_id, o.fecha_prevista,
           o.cliente_id, c.nombre AS cliente_nombre, c.zona AS cliente_zona, c.direccion AS cliente_direccion, c.telefono AS cliente_telefono,
           c.tecnico_nombre AS contacto_nombre, c.tecnico_telefono AS contacto_telefono,
           o.maquina_id, m.marca AS maquina_marca, m.modelo AS maquina_modelo, m.bastidor AS maquina_bastidor, m.num_flota AS maquina_flota,
           bd.id AS bloque_id, bd.hora_inicio AS bloque_hora, bd.duracion_min AS bloque_min, bd.nota AS bloque_nota,
           (SELECT MAX(b2.dia) FROM ot_bloques b2 WHERE b2.ot_id = o.id AND b2.tecnico_id = @t AND b2.dia < @d) AS bloque_anterior
      FROM ot o
      JOIN estados e ON e.codigo = o.estado
      JOIN clientes c ON c.id = o.cliente_id
      LEFT JOIN etiquetas et ON et.codigo = o.etiqueta
      LEFT JOIN maquinas m ON m.id = o.maquina_id
      LEFT JOIN ot_bloques bd ON bd.id = (SELECT b1.id FROM ot_bloques b1 WHERE b1.ot_id = o.id AND b1.tecnico_id = @t AND b1.dia = @d ORDER BY b1.hora_inicio, b1.id LIMIT 1)
     WHERE o.estado IN ('planificada', 'en_curso')
       AND (bd.id IS NOT NULL
            OR (o.estado = 'en_curso' AND (o.tecnico_id = @t OR EXISTS (SELECT 1 FROM ot_tiempos x WHERE x.ot_id = o.id AND x.tecnico_id = @t)))
            OR (o.estado = 'planificada' AND o.tecnico_id = @t AND NOT EXISTS (SELECT 1 FROM ot_bloques b3 WHERE b3.ot_id = o.id AND b3.dia >= @d)))
     ORDER BY (o.estado = 'en_curso') DESC, (bd.id IS NULL), bd.hora_inicio, o.prioridad, COALESCE(o.fecha_prevista, '9999'), o.id
     LIMIT ${TAREAS_MAX}`),
  proximos: db.prepare(`
    SELECT b.id AS bloque_id, b.dia, b.hora_inicio, b.duracion_min, b.nota AS bloque_nota,
           o.id, o.numero, o.estado, o.prioridad, o.tipo, o.sintoma, c.nombre AS cliente_nombre, c.zona AS cliente_zona,
           m.marca AS maquina_marca, m.modelo AS maquina_modelo
      FROM ot_bloques b
      JOIN ot o ON o.id = b.ot_id
      JOIN estados e ON e.codigo = o.estado
      JOIN fases fa ON fa.codigo = e.fase
      JOIN clientes c ON c.id = o.cliente_id
      LEFT JOIN maquinas m ON m.id = o.maquina_id
     WHERE b.tecnico_id = ? AND b.dia > ? AND b.dia <= ? AND fa.abierta = 1
     ORDER BY b.dia, b.hora_inicio, b.id LIMIT 60`),
  resumenDia: db.prepare(`SELECT tipo, COALESCE(SUM(${tiempos.SEGUNDOS('COALESCE(fin, ?)', 'inicio')}), 0) AS s FROM ot_tiempos WHERE tecnico_id = ? AND substr(inicio, 1, 10) = ? GROUP BY tipo`),
  previstoDia: db.prepare('SELECT COALESCE(SUM(duracion_min), 0) AS min FROM ot_bloques WHERE tecnico_id = ? AND dia = ?'),
  firmaBloques: db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(id), 0) AS s, COALESCE(MAX(COALESCE(actualizado, creado)), '') AS m FROM ot_bloques WHERE tecnico_id = ?`),
  firmaOT: db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(o.version), 0) AS v FROM ot o JOIN estados e ON e.codigo = o.estado JOIN fases fa ON fa.codigo = e.fase WHERE fa.abierta = 1'),
  firmaTiempos: db.prepare('SELECT COUNT(*) AS n, COUNT(fin) AS c, COALESCE(MAX(id), 0) AS m FROM ot_tiempos'),
  firmaChecklist: db.prepare(`SELECT COUNT(*) AS n, COUNT(resultado) AS c, COALESCE(MAX(fecha), '') AS m FROM ot_checklist`),
};

const cronoPublico = (t) => (t ? { id: t.id, ot_id: t.ot_id, numero: t.numero, tipo: t.tipo, nombre: tiempos.NOMBRE_TIPO[t.tipo], inicio: t.inicio, segundos: t.segundos, otro_dia: t.otro_dia } : null);

module.exports = function montarRutasTecnico(app) {
  const r = express.Router();

  // El día del técnico. Quien ficha ve el suyo; la oficina (Planificador) puede pedir el de un técnico con ?tecnico_id=N.
  r.get('/mi-dia', requierePermiso('ot.tiempos', 'planificador.ver'), (req, res) => {
    let tecnico;
    if (alcanceDe(req.usuario.rol) === 'asignadas') tecnico = { id: req.usuario.id, nombre: req.usuario.nombre, rol: req.usuario.rol };
    else {
      const tid = entero(req.query.tecnico_id, { nombre: 'tecnico_id', obligatorio: true, min: 1 });
      tecnico = stmt.tecnico.get(tid);
      if (!tecnico) throw new ErrorHttp(404, 'Técnico no encontrado');
      tecnico = { id: tecnico.id, nombre: tecnico.nombre, rol: tecnico.rol };
    }
    const hoyIso = ahora().slice(0, 10);
    const dia = req.query.dia === undefined ? hoyIso : String(req.query.dia);
    if (!esFecha(dia)) throw new ErrorHttp(400, 'dia debe ser una fecha AAAA-MM-DD válida');

    const fb = stmt.firmaBloques.get(tecnico.id), fo = stmt.firmaOT.get(), ft = stmt.firmaTiempos.get(), fc = stmt.firmaChecklist.get();
    const etag = `"${crypto.createHash('sha1').update(`midia|${tecnico.id}|${dia}|${hoyIso}|${fb.n}|${fb.s}|${fb.m}|${fo.n}|${fo.v}|${ft.n}|${ft.c}|${ft.m}|${fc.n}|${fc.c}|${fc.m}|${req.usuario.id}`).digest('hex').slice(0, 20)}"`;
    if (req.headers['if-none-match'] === etag) return res.status(304).end();

    const abierto = tiempos.abiertoDe(tecnico.id);
    const tareas = stmt.tareas.all({ t: tecnico.id, d: dia }).map((o) => {
      tiempos.asegurarChecklist(o);
      const { tiempo } = tiempos.tiemposOT(o.id);
      const p = stmt.progreso.get(o.id);
      const { bloque_id, bloque_hora, bloque_min, bloque_nota, ...ot } = o;
      return {
        ...ot,
        grupo: o.estado === 'en_curso' ? 'en_curso' : bloque_id ? 'hoy' : 'atrasada',
        bloque: bloque_id ? { id: bloque_id, dia, hora_inicio: bloque_hora, duracion_min: bloque_min, nota: bloque_nota } : null,
        tiempo,
        crono: abierto && abierto.ot_id === o.id ? cronoPublico(abierto) : null,
        checklist: { total: p.total, respondidos: p.respondidos },
      };
    });
    const resumen = { desplazamiento: 0, espera: 0, trabajo: 0, total: 0 };
    for (const f of stmt.resumenDia.all(ahora(), tecnico.id, dia)) { if (resumen[f.tipo] !== undefined) resumen[f.tipo] = f.s; resumen.total += f.s; }

    res.set('ETag', etag);
    res.json({
      generado: ahora(), hoy: hoyIso, dia, tecnico, jornada: JORNADA,
      crono: cronoPublico(abierto),
      tareas,
      proximos: stmt.proximos.all(tecnico.id, dia, sumarDias(dia, DIAS_PROXIMOS)),
      resumen: { ...resumen, previsto_min: stmt.previstoDia.get(tecnico.id, dia).min, horas_dia: JORNADA.horas_dia },
    });
  });

  // Cronómetro: empezar o cambiar de fase (desplazamiento → espera → trabajo) o parar por hoy.
  r.post('/ot/:id/crono', requierePermiso('ot.tiempos'), (req, res) => {
    if (alcanceDe(req.usuario.rol) !== 'asignadas') throw new ErrorHttp(403, 'Solo el técnico o el SAT fichan sus tiempos');
    const id = idRuta(req.params.id);
    const b = req.body || {};
    const accion = enumerado(b.accion, { nombre: 'accion', valores: [...tiempos.TIPOS, 'parar'] });
    if (!accion) throw new ErrorHttp(400, 'Falta el campo "accion"');
    const nota = texto(b.nota, { nombre: 'nota', max: 500 });
    const ot = rutasOT.cargarOT(req, id); // alcance
    const usuario = req.usuario;

    db.transaction(() => {
      const cuando = ahora();
      const abierto = tiempos.abiertoDe(usuario.id);
      if (accion === 'parar') {
        if (!abierto || abierto.ot_id !== id) throw new ErrorHttp(400, 'No tienes el cronómetro en marcha en esta O.T.');
        tiempos.cerrarTramo(abierto, 'parar', cuando);
        const { tiempo } = tiempos.tiemposOT(id);
        stmt.historial.run(id, ot.estado, ot.estado, usuario.id, cuando, `Paro por hoy (trabajo acumulado: ${tiempos.textoDuracion(tiempo.trabajo)})${nota ? ' · ' + nota : ''}`);
        return;
      }
      if (ot.es_final || !['planificada', 'en_curso'].includes(ot.estado)) {
        throw new ErrorHttp(400, `La O.T. está en "${ot.estado_nombre}": solo se ficha en las planificadas o en curso`, { estado: ot.estado });
      }
      if (abierto && abierto.ot_id !== id) {
        if (b.cerrar_otra !== true) {
          throw new ErrorHttp(409, `Tienes el cronómetro en marcha en la O.T. ${abierto.numero} (${tiempos.NOMBRE_TIPO[abierto.tipo].toLowerCase()})`, { abierto: cronoPublico(abierto) });
        }
        tiempos.cerrarTramo(abierto, 'otra_ot', cuando);
        const otra = stmt.estadoOT.get(abierto.ot_id);
        stmt.historial.run(abierto.ot_id, otra.estado, otra.estado, usuario.id, cuando, `Cronómetro parado al empezar la O.T. ${ot.numero}`);
      } else if (abierto) {
        if (abierto.tipo === accion) throw new ErrorHttp(400, `Ya estás en "${tiempos.NOMBRE_TIPO[accion].toLowerCase()}" en esta O.T.`);
        tiempos.cerrarTramo(abierto, 'cambio', cuando);
      }
      tiempos.abrirTramo({ otId: id, tecnicoId: usuario.id, tipo: accion, nota, cuando });
      if (ot.estado === 'planificada') rutasOT.aplicarCambioEstado({ otId: id, destino: 'en_curso', usuario, nota: `Cronómetro: ${tiempos.NOMBRE_TIPO[accion].toLowerCase()}` });
    }).immediate();

    res.json({ crono: cronoPublico(tiempos.abiertoDe(usuario.id)), ot: rutasOT.detalleOT(req, id) });
  });

  // Tramos y totales de una O.T. (también van dentro del detalle de la O.T.).
  r.get('/ot/:id/tiempos', requierePermiso('ot.ver'), (req, res) => {
    const id = idRuta(req.params.id);
    rutasOT.cargarOT(req, id);
    const { tramos, tiempo } = tiempos.tiemposOT(id);
    res.json({ tramos, tiempo });
  });

  // Responder un punto del checklist: hecho, no aplica o incidencia (con nota); null lo deja sin responder.
  r.put('/ot/:id/checklist/:pid', requierePermiso('ot.checklist'), (req, res) => {
    const id = idRuta(req.params.id);
    const pid = idRuta(req.params.pid);
    const b = req.body || {};
    const ot = rutasOT.cargarOT(req, id);
    if (ot.es_final) throw new ErrorHttp(400, 'La O.T. está cerrada: el checklist ya no se puede cambiar');
    if (b.resultado === undefined) throw new ErrorHttp(400, 'Falta el campo "resultado"');
    const resultado = b.resultado === null || b.resultado === '' ? null : String(b.resultado);
    const nota = texto(b.nota, { nombre: 'nota', max: 500 });
    const punto = tiempos.responderPunto({ otId: id, puntoId: pid, resultado, nota, usuario: req.usuario });
    res.json({ punto, checklist: tiempos.checklistOT(id), requisitos: tiempos.requisitosFinalizar(ot) });
  });

  app.use('/api', r);
};
