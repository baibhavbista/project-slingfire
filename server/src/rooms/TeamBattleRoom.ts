import { Room, Client } from "@colyseus/core";
import { TeamBattleState } from "./schema/TeamBattleState";
import { Player } from "./schema/Player";
import { Bullet } from "./schema/Bullet";
import { checkBulletPlatformCollision } from "../../../shared/WorldGeometry";
import { SHARED_CONFIG } from "../../../shared/GameConstants";

export class TeamBattleRoom extends Room<TeamBattleState> {
  maxClients = 8; // 4v4

  onCreate(_options: any) {
    this.setState(new TeamBattleState());
    
    // Set up message handlers
    this.onMessage("move", (client, data) => {
      const player = this.state.players.get(client.sessionId);
      if (player && !player.isDead) {
        player.x = data.x;
        player.y = data.y;
        player.velocityX = data.velocityX;
        player.velocityY = data.velocityY;
        player.flipX = data.flipX;
      }
    });

    this.onMessage("dash", (client, data) => {
      const player = this.state.players.get(client.sessionId);
      if (player && !player.isDead) {
        player.isDashing = data.isDashing;
      }
    });

    this.onMessage("shoot", (client, data) => {
      const player = this.state.players.get(client.sessionId);
      if (player && !player.isDead && this.state.gameState === "playing") {
        console.log(`[Server] Received shoot from ${client.sessionId}:`, {
          receivedData: data,
          playerPos: { x: player.x, y: player.y },
          playerFlipX: player.flipX
        });
        
        // Validate basic bullet position data
        if (!data || isNaN(data.x) || isNaN(data.y)) {
          console.error(`Invalid shoot data from ${client.sessionId}:`, data);
          return;
        }
        
        // Server calculates velocity based on player direction
        const direction = player.flipX ? -1 : 1;
        const velocityX = SHARED_CONFIG.BULLET.SPEED * direction;
        
        // Create bullet
        const bulletId = `${client.sessionId}-${Date.now()}`;
        const bullet = new Bullet(
          bulletId,
          data.x,
          data.y,
          velocityX,  // Server-calculated velocity
          client.sessionId,
          player.team
        );
        
        console.log(`[Server] Creating bullet:`, {
          id: bulletId,
          pos: { x: bullet.x, y: bullet.y },
          velocityX: bullet.velocityX,
          team: bullet.ownerTeam
        });
        
        // Final validation before adding
        if (isNaN(bullet.x) || isNaN(bullet.y) || isNaN(bullet.velocityX)) {
          console.error(`Bullet creation resulted in NaN values:`, {
            x: bullet.x,
            y: bullet.y,
            velocityX: bullet.velocityX,
            id: bullet.id
          });
          return;
        }
        
        this.state.bullets.push(bullet);
        
        // Remove bullet after lifetime expires
        this.clock.setTimeout(() => {
          const index = this.state.bullets.findIndex(b => b.id === bulletId);
          if (index !== -1) {
            this.state.bullets.splice(index, 1);
          }
        }, SHARED_CONFIG.BULLET.LIFETIME_MS);
      }
    });
    
    // Set up tick rate (60 FPS)
    this.setSimulationInterval((deltaTime) => this.update(deltaTime), 1000 / 60);
    
    // Update room metadata
    this.updateRoomMetadata();
    
    console.log(`TeamBattleRoom created with ID: ${this.roomId}`);
  }

  onJoin(client: Client, options: any) {
    console.log(`Room ${this.roomId}: Player ${client.sessionId} joined!`);
    
    const playerName = options?.name || `Player${client.sessionId.substring(0, 4)}`;
    const player = this.state.addPlayer(client.sessionId, playerName);
    
    // Log current state
    console.log(`Room ${this.roomId}: Current players count: ${this.state.players.size}`);
    this.state.players.forEach((p, id) => {
      console.log(`  - Player ${id}: team ${p.team}, pos (${p.x}, ${p.y}), name: ${p.name}`);
    });
    
    // Notify client of their team
    client.send("team-assigned", { 
      team: player.team,
      playerId: client.sessionId,
      roomId: this.roomId,
      playerName: player.name
    });
    
    // Update metadata (including potential game state change)
    this.updateRoomMetadata();
  }

  onLeave(client: Client, consented: boolean) {
    console.log(`Room ${this.roomId}: Player ${client.sessionId} left!`);
    
    this.state.removePlayer(client.sessionId);
    
    // Update metadata
    this.updateRoomMetadata();
  }

  onDispose() {
    console.log(`Room ${this.roomId} disposing...`);
  }
  
  updateRoomMetadata() {
    const redCount = this.state.getTeamCount("red");
    const blueCount = this.state.getTeamCount("blue");
    
    this.setMetadata({
      redCount,
      blueCount,
      gameState: this.state.gameState
    });
  }

  update(deltaTime: number) {
    // Only update if game is playing
    if (this.state.gameState !== "playing") return;
    
    // Defensive check for deltaTime
    if (!deltaTime || isNaN(deltaTime)) {
      console.error("Invalid deltaTime:", deltaTime);
      return;
    }

    // Update game time
    this.state.gameTime += deltaTime;

    // Update respawn timers
    this.state.players.forEach(player => {
      if (player.isDead && player.respawnTimer > 0) {
        player.respawnTimer -= deltaTime;
        if (player.respawnTimer <= 0) {
          // Respawn player
          player.isDead = false;
          player.health = 100;
          
          // Reset position to team spawn
          if (player.team === "red") {
            player.x = 200;
            player.y = 500;
          } else {
            player.x = 2800;
            player.y = 500;
          }
        }
      }
    });

    // Simple bullet collision (will be improved later)
    const bulletsToRemove: number[] = [];
    
    // Player hitbox dimensions with small buffer for tunneling prevention
    const PLAYER_HALF_WIDTH = 18;  // 32px width / 2 + 2px buffer
    const PLAYER_HALF_HEIGHT = 26; // 48px height / 2 + 2px buffer
    const BULLET_HALF_WIDTH = SHARED_CONFIG.BULLET.WIDTH / 2;
    const BULLET_HALF_HEIGHT = SHARED_CONFIG.BULLET.HEIGHT / 2;
    
    this.state.bullets.forEach((bullet, index) => {
      // Defensive checks for bullet data
      if (isNaN(bullet.x) || isNaN(bullet.velocityX)) {
        console.error(`Invalid bullet data: x=${bullet.x}, velocityX=${bullet.velocityX}, id=${bullet.id}`);
        bulletsToRemove.push(index);
        return;
      }
      
      // Calculate bullet movement for this frame
      const deltaSeconds = deltaTime / 1000;
      const movement = bullet.velocityX * deltaSeconds;
      const bulletPrevX = bullet.x; // Current position (before update)
      const bulletNextX = bullet.x + movement; // Next position

      console.log("bulletPrevX", bulletPrevX);
      console.log("bulletNextX", bulletNextX);
      
      // Use continuous collision detection
      let bulletHit = false;
      
      for (const player of this.state.players.values()) {
        if (player.id !== bullet.ownerId && 
            player.team !== bullet.ownerTeam && 
            !player.isDead) {
          
          // Get player bounding box
          // Note: player.y is at bottom-center on client, so we adjust to get center
          const playerCenterY = player.y - PLAYER_HALF_HEIGHT;
          const playerLeft = player.x - PLAYER_HALF_WIDTH;
          const playerRight = player.x + PLAYER_HALF_WIDTH;
          const playerTop = playerCenterY - PLAYER_HALF_HEIGHT;
          const playerBottom = playerCenterY + PLAYER_HALF_HEIGHT;
          
          // Get bullet's swept bounding box (the area it covers during movement)
          const bulletTop = bullet.y - BULLET_HALF_HEIGHT;
          const bulletBottom = bullet.y + BULLET_HALF_HEIGHT;
          const bulletLeft = Math.min(bulletPrevX, bulletNextX) - BULLET_HALF_WIDTH;
          const bulletRight = Math.max(bulletPrevX, bulletNextX) + BULLET_HALF_WIDTH;
          
          // Check if swept bullet box intersects player box
          if (bulletLeft < playerRight &&
              bulletRight > playerLeft &&
              bulletTop < playerBottom &&
              bulletBottom > playerTop) {
            
            // Hit detected
            player.health -= SHARED_CONFIG.BULLET.DAMAGE;
            
            if (player.health <= 0) {
              player.isDead = true;
              player.health = 0;
              player.respawnTimer = 3000; // 3 seconds
            
              // Get killer player for the name
              const killer = this.state.players.get(bullet.ownerId);
              
              // Broadcast kill event
              this.broadcast("player-killed", {
                killerId: bullet.ownerId,
                victimId: player.id,
                killerName: killer?.name || "Unknown",
                victimName: player.name
              });
              
              // Update score
              if (bullet.ownerTeam === "red") {
                this.state.scores.red++;
              } else {
                this.state.scores.blue++;
              }
              
              // Check win condition
              if (this.state.scores.red >= 30 || this.state.scores.blue >= 30) {
                this.state.gameState = "ended";
                this.state.winningTeam = this.state.scores.red >= 30 ? "red" : "blue";
                this.updateRoomMetadata();
                this.broadcast("match-ended", {
                  winningTeam: this.state.winningTeam,
                  scores: this.state.scores
                });
              }
            }
            console.log("update: Bullet hit a player", bullet.x, bullet.y, player.x, player.y);
            // Mark bullet for removal and stop checking other players
            bulletsToRemove.push(index);

            bulletHit = true;
            break;
          }
        }
      }
      
      // If bullet didn't hit anyone, update its position
      if (!bulletHit) {
        // Update bullet position to the next position we calculated
        bullet.x = bulletNextX;
        
        // Check collision with platforms
        const platformHit = checkBulletPlatformCollision({
          x: bullet.x,
          y: bullet.y,
          width: SHARED_CONFIG.BULLET.WIDTH,
          height: SHARED_CONFIG.BULLET.HEIGHT
        });
        
        if (platformHit) {
          // Bullet hit a platform, mark for removal
          console.log("update: Bullet hit a platform", bullet.x, bullet.y, platformHit);
          bulletsToRemove.push(index);
        } else if (bullet.x < -100 || bullet.x > 3100) {
          // Remove bullets that are off-screen
          console.log("update: Bullet went off-screen");
          bulletsToRemove.push(index);
        }
      }
    });
    
    // Remove bullets that hit or went off-screen
    bulletsToRemove.sort((a, b) => b - a); // Sort in reverse order
    const uniqueIndices = [...new Set(bulletsToRemove)]; // Remove duplicates
    uniqueIndices.forEach(index => {
      if (index >= 0 && index < this.state.bullets.length) {
        this.state.bullets.splice(index, 1);
      }
    });
  }
} 