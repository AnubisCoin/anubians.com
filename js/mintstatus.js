"use strict";

var connection = new signalR.HubConnectionBuilder().withUrl("/statusHub").build();

connection.start().then(function () {
    connection.invoke("AddToGroup", mintId).catch(function (err) {
        return console.error(err.toString());
    });
}).catch(function (err) {
    return console.error(err.toString());
});

connection.on("StatusUpdate", async function (id) {
    if (id != mintId) {
        console.log('Unexpected id ' + id);
        return;
    }

    let response = await fetch('/mint/_status/' + mintId);
    if (response.ok) {
        document.getElementById('statusDiv').innerHTML = await response.text();
    }
});

