// rutas-fichajes.js — API de jornadas, O.T. comodín (F4-07) e incidencias de fichaje (F4-08). La lógica está en fichajes.js.
//
//   POST   /api/comodin/crono { accion, concepto?, nota?, cerrar_otra? }   accion = empezar | parar. Horas sin O.T. del técnico.
//   GET    /api/jornadas[?mes=AAAA-MM | ?desde&hasta][&tecnico_id=N]      horas fichadas por técnico y día frente a la jornada
//   GET    /api/jornadas/dia?dia=AAAA-MM-DD[&tecnico_id=N]                tramos de un día, O.T. imputables e incidencias del día
//   GET    /api/incidencias[?estado=pendiente|resueltas|todas][&tecnico_id=N]
//   GET    /api/incidencias/pendientes                                    { n } para el contador de la cabecera
//   POST   /api/incidencias { accion, motivo, ... }                       accion = modificar | anadir | quitar
//   POST   /api/incidencias/:id/resolver { aprobar, respuesta? }
//   DELETE /api/incidencias/:id                                           la retira quien la pidió, mientras esté pendiente
//
// Reglas:
//   - El técnico y el SAT (alcance `asignadas`) solo ven lo suyo: sus jornadas y sus incidencias; piden correcciones, no las aplican.
//   - La oficina con `fichajes.ver` ve a todos; con `fichajes.gestionar` aprueba o rechaza y puede corregir directamente (la
//     incidencia nace aprobada: mismo rastro).
//   - El comodín usa el mismo cronómetro que las O.T.: un solo tramo abierto por técnico. Si lo tiene en una O.T., 409 con
//     `abierto` salvo que mande `cerrar_otra`.

const express = require('express');
const { db, ahora } = require('./db');
const { requierePermiso, alcanceDe, puede } = require('./permisos');
const { ErrorHttp, texto, entero, enumerado, idRuta } = require('./validar');
const tiempos = require('./tiempos');
const fichajes = require('./fichajes');

const stmt = {
  historial: db.prepare('INSERT INTO ot_historial (ot_id, estado_anterior, estado_nuevo, usuario_id, fecha, nota) VALUES (?, ?, ?, ?, ?, ?)'),
  estadoOT: db.prepare('SELECT estado FROM ot WHERE id = ?'),
};

const esTecnico = (req) => alcanceDe(req.usuario.rol) === 'asignadas';

// De quién se piden los datos: el propio técnico, o el que diga la oficina con ?tecnico_id (obligatorio si `obligatorio`).
function tecnicoDe(req, valor, { obligatorio = true } = {}) {
  if (esTecnico(req)) return { id: req.usuario.id, nombre: req.usuario.nombre, rol: req.usuario.rol };
  const id = entero(valor, { nombre: 'tecnico_id', obligatorio, min: 1 });
  if (!id) return null;
  const t = fichajes.tecnicoPorId(id);
  if (!t) throw new ErrorHttp(404, 'Técnico no encontrado');
  return { id: t.id, nombre: t.nombre, rol: t.rol };
}

module.exports = function montarRutasFichajes(app) {
  const r = express.Router();

  // Cronómetro del comodín: empezar (o cambiar de concepto) y parar.
  r.post('/comodin/crono', requierePermiso('ot.tiempos'), (req, res) => {
    if (!esTecnico(req)) throw new ErrorHttp(403, 'Solo el técnico o el SAT fichan sus tiempos');
    const b = req.body || {};
    const accion = enumerado(b.accion, { nombre: 'accion', valores: ['empezar', 'parar'] });
    if (!accion) throw new ErrorHttp(400, 'Falta el campo "accion"');
    const nota = texto(b.nota, { nombre: 'nota', max: 500 });
    const usuario = req.usuario;

    db.transaction(() => {
      const cuando = ahora();
      const abierto = tiempos.abiertoDe(usuario.id);
      if (accion === 'parar') {
        if (!abierto || !abierto.comodin_id) throw new ErrorHttp(400, 'No tienes el cronómetro en marcha en el comodín');
        tiempos.cerrarTramo(abierto, 'parar', cuando);
        return;
      }
      const concepto = fichajes.conceptoValido(b.concepto);
      if (concepto.ausencia) throw new ErrorHttp(400, `"${concepto.nombre}" es una ausencia: no se ficha con el cronómetro, se añade al día desde Mis horas`);
      if (concepto.pide_nota && !nota) throw new ErrorHttp(400, `"${concepto.nombre}" necesita una nota que diga qué se ha hecho`);
      if (abierto && abierto.ot_id) {
        if (b.cerrar_otra !== true) throw new ErrorHttp(409, `Tienes el cronómetro en marcha en ${tiempos.dondeEsta(abierto)}`, { abierto: tiempos.cronoPublico(abierto) });
        tiempos.cerrarTramo(abierto, 'otra_ot', cuando);
        const otra = stmt.estadoOT.get(abierto.ot_id);
        stmt.historial.run(abierto.ot_id, otra.estado, otra.estado, usuario.id, cuando, `Cronómetro parado al pasar al comodín (${concepto.nombre})`);
      } else if (abierto) {
        if (abierto.concepto === concepto.codigo) throw new ErrorHttp(400, `Ya estás en "${concepto.nombre}"`);
        tiempos.cerrarTramo(abierto, 'cambio', cuando);
      }
      const comodin = fichajes.asegurarComodin(usuario.id, cuando.slice(0, 7));
      tiempos.abrirTramo({ comodinId: comodin.id, concepto: concepto.codigo, tecnicoId: usuario.id, nota, cuando });
    }).immediate();

    const hoy = ahora().slice(0, 10);
    res.json({ crono: tiempos.cronoPublico(tiempos.abiertoDe(usuario.id)), comodin: fichajes.comodinPublico(usuario.id, hoy.slice(0, 7), hoy) });
  });

  // Jornadas: horas fichadas por técnico y día. Por defecto, el mes en curso.
  r.get('/jornadas', requierePermiso('ot.tiempos', 'fichajes.ver'), (req, res) => {
    if (!esTecnico(req) && !puede(req.usuario.rol, 'fichajes.ver')) throw new ErrorHttp(403, 'No tienes permiso para ver las jornadas');
    let desde, hasta;
    if (req.query.desde !== undefined || req.query.hasta !== undefined) { desde = String(req.query.desde || ''); hasta = String(req.query.hasta || ''); }
    else {
      const mes = req.query.mes === undefined ? ahora().slice(0, 7) : String(req.query.mes);
      if (!fichajes.esMes(mes)) throw new ErrorHttp(400, 'mes debe ser AAAA-MM');
      desde = `${mes}-01`; hasta = fichajes.finDeMes(mes);
    }
    const tecnico = tecnicoDe(req, req.query.tecnico_id, { obligatorio: false });
    const j = fichajes.jornadas({ desde, hasta, tecnicoId: tecnico ? tecnico.id : null });
    res.json({
      generado: ahora(), ...j,
      incidencias_pendientes: esTecnico(req) ? fichajes.pendientesDe(req.usuario.id) : fichajes.pendientes(),
      puede_gestionar: puede(req.usuario.rol, 'fichajes.gestionar') && !esTecnico(req) ? 1 : 0,
    });
  });

  // Un día de un técnico: tramos, resumen, O.T. a las que puede imputar e incidencias de ese día.
  r.get('/jornadas/dia', requierePermiso('ot.tiempos', 'fichajes.ver'), (req, res) => {
    if (!esTecnico(req) && !puede(req.usuario.rol, 'fichajes.ver')) throw new ErrorHttp(403, 'No tienes permiso para ver las jornadas');
    const tecnico = tecnicoDe(req, req.query.tecnico_id);
    const dia = req.query.dia === undefined ? ahora().slice(0, 10) : String(req.query.dia);
    res.json({ generado: ahora(), ...fichajes.detalleDia(tecnico, dia), puede_gestionar: puede(req.usuario.rol, 'fichajes.gestionar') && !esTecnico(req) ? 1 : 0 });
  });

  r.get('/incidencias/pendientes', requierePermiso('ot.tiempos', 'fichajes.ver'), (req, res) => {
    res.json({ n: esTecnico(req) ? fichajes.pendientesDe(req.usuario.id) : puede(req.usuario.rol, 'fichajes.ver') ? fichajes.pendientes() : 0 });
  });

  r.get('/incidencias', requierePermiso('ot.tiempos', 'fichajes.ver'), (req, res) => {
    if (!esTecnico(req) && !puede(req.usuario.rol, 'fichajes.ver')) throw new ErrorHttp(403, 'No tienes permiso para ver las incidencias');
    const tecnico = tecnicoDe(req, req.query.tecnico_id, { obligatorio: false });
    const estado = req.query.estado === undefined ? 'pendiente' : String(req.query.estado);
    for (const k of ['desde', 'hasta']) if (req.query[k] !== undefined && !fichajes.esFecha(String(req.query[k]))) throw new ErrorHttp(400, `${k} debe ser una fecha AAAA-MM-DD válida`);
    const incidencias = fichajes.listarIncidencias({ tecnicoId: tecnico ? tecnico.id : null, estado, desde: req.query.desde || null, hasta: req.query.hasta || null });
    res.json({
      generado: ahora(), estado, incidencias,
      pendientes: esTecnico(req) ? fichajes.pendientesDe(req.usuario.id) : fichajes.pendientes(),
      puede_gestionar: puede(req.usuario.rol, 'fichajes.gestionar') && !esTecnico(req) ? 1 : 0,
    });
  });

  // Pedir una corrección (técnico) o corregir directamente (oficina con fichajes.gestionar, indicando tecnico_id).
  r.post('/incidencias', requierePermiso('ot.tiempos', 'fichajes.gestionar'), (req, res) => {
    const b = req.body || {};
    const directa = !esTecnico(req);
    if (directa && !puede(req.usuario.rol, 'fichajes.gestionar')) throw new ErrorHttp(403, 'No tienes permiso para corregir fichajes');
    const tecnico = tecnicoDe(req, b.tecnico_id);
    const incidencia = fichajes.crearIncidencia({ usuario: req.usuario, tecnico, cuerpo: b, directa });
    res.status(201).json({ incidencia });
  });

  r.post('/incidencias/:id/resolver', requierePermiso('fichajes.gestionar'), (req, res) => {
    if (esTecnico(req)) throw new ErrorHttp(403, 'No tienes permiso para resolver incidencias');
    const id = idRuta(req.params.id);
    const b = req.body || {};
    if (typeof b.aprobar !== 'boolean') throw new ErrorHttp(400, 'Falta el campo "aprobar" (true o false)');
    const respuesta = texto(b.respuesta, { nombre: 'respuesta', max: 500 });
    res.json({ incidencia: fichajes.resolverIncidencia({ id, usuario: req.usuario, aprobar: b.aprobar, respuesta }), pendientes: fichajes.pendientes() });
  });

  r.delete('/incidencias/:id', requierePermiso('ot.tiempos', 'fichajes.gestionar'), (req, res) => {
    res.json({ incidencia: fichajes.anularIncidencia({ id: idRuta(req.params.id), usuario: req.usuario }) });
  });

  app.use('/api', r);
};
