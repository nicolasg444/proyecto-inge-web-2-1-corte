import { auth, db } from "./firebase-config.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import { doc, serverTimestamp, setDoc } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
import {
  buildSimulationFirestorePatch,
  ensureTripSimulationFields,
  generarRutaSimulada
} from "./trip-simulation.js";

const seedTripsBtn = document.getElementById("seedTripsBtn");
const seedOutput = document.getElementById("seedOutput");

let currentUser = null;

function log(message) {
  seedOutput.textContent += `\n${message}`;
}

function setLog(message) {
  seedOutput.textContent = message;
}

function makeTrip(data) {
  const normalized = ensureTripSimulationFields({
    ...data,
    route: generarRutaSimulada(data.origen, data.destino, data.puntoIntermedio1, data.puntoIntermedio2)
  });

  return {
    ...normalized,
    ...buildSimulationFirestorePatch(normalized),
    userId: data.userId,
    userEmail: data.userEmail,
    travelers: data.travelers || 2,
    budget: data.budget || 0,
    notes: data.notes || "",
    assignedBy: data.assignedBy,
    assignedByEmail: data.assignedByEmail,
    assignedByName: data.assignedByName,
    managedBy: data.assignedBy,
    managedByEmail: data.assignedByEmail,
    managedByName: data.assignedByName,
    createdByRole: "admin",
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  };
}

function simulatedTripsFor(user) {
  const adminName = user.displayName || "Administrador WayTure";
  const email = user.email || "admin@wayture.com";
  const shared = {
    userId: user.uid,
    userEmail: email.toLowerCase(),
    assignedBy: user.uid,
    assignedByEmail: email.toLowerCase(),
    assignedByName: adminName
  };

  return [
    makeTrip({
      ...shared,
      id: "wt-cartagena-demo",
      codigoViaje: "WT-CARTAGENA-01",
      nombreViaje: "Escapada Caribe Cartagena",
      origen: "Aeropuerto Internacional El Dorado, Bogota",
      destino: "Cartagena, Colombia",
      puntoIntermedio1: "Barranquilla",
      puntoIntermedio2: "Aeropuerto Internacional Rafael Nunez",
      estado: "En ruta",
      progreso: 45,
      travelers: 3,
      budget: 4200000,
      notes: "Ruta simulada para pruebas de rastreo y panel administrativo."
    }),
    makeTrip({
      ...shared,
      id: "wt-medellin-demo",
      codigoViaje: "WT-MEDELLIN-02",
      nombreViaje: "Fin de semana en Medellin",
      origen: "Aeropuerto Internacional El Dorado, Bogota",
      destino: "Medellin, Colombia",
      puntoIntermedio1: "Pereira",
      puntoIntermedio2: "Aeropuerto Internacional Jose Maria Cordova",
      estado: "Planificado",
      progreso: 0,
      travelers: 2,
      budget: 2600000,
      notes: "Viaje listo para iniciar simulacion GPS."
    }),
    makeTrip({
      ...shared,
      id: "wt-sanandres-demo",
      codigoViaje: "WT-SANANDRES-03",
      nombreViaje: "Azul profundo San Andres",
      origen: "Aeropuerto Internacional El Dorado, Bogota",
      destino: "San Andres, Colombia",
      puntoIntermedio1: "Cartagena",
      puntoIntermedio2: "San Andres",
      estado: "Cerca del destino",
      progreso: 84,
      travelers: 4,
      budget: 6800000,
      notes: "Caso para probar estados cercanos al destino."
    }),
    makeTrip({
      ...shared,
      id: "wt-madrid-demo",
      codigoViaje: "WT-MADRID-04",
      nombreViaje: "Europa inicial Madrid",
      origen: "Aeropuerto Internacional El Dorado, Bogota",
      destino: "Madrid, Espana",
      puntoIntermedio1: "Aeropuerto Internacional JFK",
      puntoIntermedio2: "Aeropuerto Adolfo Suarez Madrid-Barajas",
      estado: "En preparacion",
      progreso: 15,
      travelers: 2,
      budget: 14500000,
      notes: "Ruta internacional simulada."
    }),
    makeTrip({
      ...shared,
      id: "wt-tokio-demo",
      codigoViaje: "WT-TOKIO-05",
      nombreViaje: "Aventura Tokio y Kioto",
      origen: "Aeropuerto Internacional El Dorado, Bogota",
      destino: "Tokio, Japon",
      puntoIntermedio1: "Aeropuerto Charles de Gaulle",
      puntoIntermedio2: "Aeropuerto Internacional de Narita",
      estado: "Incidencia",
      progreso: 52,
      travelers: 1,
      budget: 22000000,
      notes: "Viaje con incidencia para probar alertas."
    })
  ];
}

async function seedTrips() {
  if (!currentUser) {
    setLog("Debes iniciar sesion antes de guardar los viajes.");
    return;
  }

  seedTripsBtn.disabled = true;
  setLog("Guardando viajes en Firestore...");

  try {
    const trips = simulatedTripsFor(currentUser);

    for (const trip of trips) {
      await setDoc(doc(db, "viajes", trip.id), trip, { merge: true });
      log(`Guardado: ${trip.codigoViaje} - ${trip.nombreViaje}`);
    }

    log("");
    log("Listo. Los viajes ya estan en Firestore > viajes.");
    log("Abre admin-viajes.html#panel para verlos.");
  } catch (error) {
    console.error(error);
    log("");
    log(`Error: ${error.message}`);
    log("Si ves permisos insuficientes, revisa las reglas de Firestore.");
  } finally {
    seedTripsBtn.disabled = false;
  }
}

onAuthStateChanged(auth, user => {
  currentUser = user;
  if (!user) {
    setLog("No hay sesion activa. Ve a Login, entra con tu admin y vuelve aqui.");
    return;
  }
  setLog(`Sesion activa: ${user.email}\nListo para guardar viajes simulados.`);
});

seedTripsBtn.addEventListener("click", seedTrips);
