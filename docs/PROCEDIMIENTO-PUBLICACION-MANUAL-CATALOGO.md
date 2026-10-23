# Procedimiento operativo: publicación manual del catálogo

**Estado:** procedimiento de control para el staff.  
**Ámbito:** ServiciosCatalogo → ServiciosCatalogoPublico y ComplementosCatalogo → ComplementosCatalogoPublico.  
**Regla de negocio:** la edición y publicación son manuales e intencionadas. No implementar hooks, sincronización automática, cron de reconciliación ni replicación en segundo plano.

## 1. Principios no negociables

- Las colecciones fuente son la autoridad comercial interna; las proyecciones son la única fuente de lectura pública del catálogo.
- La publicación es una acción manual explícita del staff autorizado. Editar la fuente no significa que el cambio ya esté publicado.
- No copiar costes, márgenes, notas internas, datos de clientes, campos contables/fiscales ni metadatos operativos a las proyecciones.
- No borrar filas para “limpiar” una publicación. Las correcciones deben conservar trazabilidad y respetar referencias.
- No alterar ni inferir relaciones de complementos que no estén definidas en la fuente autorizada.
- No publicar ni validar cambios probando reservas ficticias en producción.

## 2. Flujo de publicación

1. **Preparar el cambio.** El staff actualiza manualmente la colección fuente y registra qué filas/IDs se modifican, quién solicita el cambio y el motivo.
2. **Revisar la fila fuente.** Confirmar identificador estable, título/slug, precio y moneda, duración, visibilidad y medios. Para un servicio dual, revisar los campos allowCombine, linkedPhases, phase1Duration, exposureDuration, phase2Duration y totalDuration.
3. **Validar la relación F1/F2.** La F2 debe existir con el identificador exacto en el catálogo aprobado. Las duraciones deben ser numéricas, explícitas y no negativas. La duración total debe ser coherente con F1 + exposición + F2. No hacer visible la F2 solo por estar enlazada.
4. **Copiar manualmente a la proyección pública.** Usar únicamente los campos admitidos por el esquema CMS canónico y los requeridos por el DTO público actual. No copiar la fila fuente completa ni utilizar un volcado masivo de campos.
5. **Comprobar identidad y unicidad.** Verificar que el ID comercial coincide con la fila fuente; no crear duplicados por slug, SKU o ID. Para una modificación, actualizar la fila pública existente, no insertar otra fila con el mismo identificador.
6. **Verificar el contenido publicado.** Consultar la proyección pública y comparar ID, título, slug, precio/moneda, duración, visibilidad, medios y relaciones de fases. Confirmar que los campos internos no aparecen ni en la fila pública ni en sus arrays/objetos anidados.
7. **Verificar la web como visitante anónimo.** Abrir listado, ficha de servicio, complementos y reserva online en una sesión sin iniciar sesión. Confirmar precio visible, disponibilidad y navegación. Esta comprobación no autoriza crear una reserva en producción; probar la escritura solo en QA aislado.
8. **Registrar el resultado.** Guardar fecha/hora, staff responsable, IDs afectados, motivo, conteos antes/después, checks realizados, resultado y corrección aplicada si hubo error. La evidencia no debe incluir secretos ni datos personales innecesarios.

## 3. Criterios de rechazo y recuperación

No dar por publicada una fila si ocurre cualquiera de estos casos:

- ID ausente, cambiado o duplicado; slug duplicado; precio o moneda incoherentes.
- Servicio dual con F2 inexistente, ciclo de referencias, duración ausente/no numérica/negativa o suma de fases inconsistente.
- Campo no incluido en el esquema canónico o presencia de costes, margen, notas internas, fiscalidad, contabilidad o datos personales.
- Diferencia entre la proyección y lo que muestra la web.
- Lectura anónima no verificable o error en ficha/listado/reserva.

Ante un fallo, detener nuevas publicaciones, identificar los IDs afectados, corregir manualmente la proyección y repetir las comprobaciones. No ejecutar una sincronización global automática ni revertir mediante borrado masivo. Si el fallo puede afectar reservas activas, elevarlo antes de cambiar la configuración comercial.

## 4. Checklist de cierre

- [ ] Cambios fuente identificados y aprobados.
- [ ] Filas de proyección actualizadas manualmente, sin duplicados.
- [ ] IDs y campos comerciales comparados.
- [ ] Relaciones F1/F2 y duración verificadas cuando proceda.
- [ ] Campos privados ausentes, también en estructuras anidadas.
- [ ] Listado, ficha y complementos revisados como visitante anónimo.
- [ ] Flujo de reserva revisado sin crear operaciones ficticias en producción.
- [ ] Evidencia y responsable registrados.

## 5. Límites

Este procedimiento no certifica permisos CMS anónimos, la ejecución real de webMethods, persistencia de reservas ni compensaciones de la saga. Esas pruebas requieren un sitio Wix QA independiente o un mecanismo de prueba soportado que no escriba en producción. La edición manual es una decisión deliberada del negocio y no debe sustituirse por automatización.
